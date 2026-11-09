package check

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var pinnedSHA256 = map[string]string{
	"7zr.exe":         "256feca8e274e5da655e2a284fabafd9f554365eb164862089dacd4e8276d282",
	"7z2501-extra.7z": "cd3cf38085c2cc6839cf72716dafb3175ae425f4fd34faafc6c0b64d618d307f",
	"x64/7za.exe":     "574bb90d17732f3cc4145fd4ba12d8f29b9d63400881c0e6fe3110c88b0485de",
}

const (
	// Real installers expand to at most a few GiB; the budget rejects
	// decompression bombs long before the checker can fill a disk.
	maxExtractBytes = int64(4) << 30
	// A single member larger than the payload of the largest real installer
	// is a bomb signature.
	maxExtractEntryBytes = int64(2) << 30
	// Real app trees stay far below this member count.
	maxExtractEntries = 100000
	// Deep member chains are a bomb or escape signature; real Electron trees
	// nest well below this.
	maxExtractDepth = 24
	// Wall clock for the whole extraction; every recursive stage shares it.
	maxExtractTime = 10 * time.Minute
	// Bound on in-memory capture of external 7z stdout/stderr.
	maxSevenOutputBytes = int64(64) << 20
	// Poll interval of the external 7z disk watchdog.
	sevenWatchInterval = 500 * time.Millisecond
)

// extractBudget bounds expansion across every recursive stage; stages share
// the remaining entries and bytes through the same pointer.
type extractBudget struct {
	deadline time.Time
	entries  int
	bytes    int64
	maxEntry int64
	maxDepth int
	offline  bool
}

func newExtractBudget() *extractBudget {
	return &extractBudget{deadline: time.Now().Add(maxExtractTime), entries: maxExtractEntries, bytes: maxExtractBytes, maxEntry: maxExtractEntryBytes, maxDepth: maxExtractDepth}
}

func (b *extractBudget) expired() error {
	if b == nil {
		return nil
	}
	if time.Now().After(b.deadline) {
		return extractError("extraction exceeded the elapsed time budget (limit %s)", maxExtractTime)
	}
	return nil
}

// entry charges one member: nesting depth, entry count, per-entry bytes, and
// the declared expanded size, all refused before any data of that member is
// written.
func (b *extractBudget) entry(name string, declared int64) error {
	if b == nil {
		return nil
	}
	if e := b.expired(); e != nil {
		return e
	}
	if pathDepth(name) > b.maxDepth {
		return extractError("path nesting depth budget exceeded (limit %d): %s", b.maxDepth, name)
	}
	if b.entries <= 0 {
		return extractError("extraction entry budget exceeded (limit %d)", maxExtractEntries)
	}
	b.entries--
	if declared > b.maxEntry {
		return extractError("per-entry bytes budget exceeded (limit %d): %s declares %d bytes", b.maxEntry, name, declared)
	}
	if declared > b.bytes {
		return extractError("archive member %s declares %d bytes past the expanded bytes budget (limit %d bytes per installer)", name, declared, maxExtractBytes)
	}
	return nil
}

// written charges bytes as they land on disk and checks the shared deadline
// cooperatively; a blocked write is checked once it returns.
func (b *extractBudget) written(n int64) error {
	if b == nil {
		return nil
	}
	if n > 0 {
		b.bytes -= n
		if b.bytes < 0 {
			return extractError("extraction wrote past the expanded bytes budget (limit %d bytes per installer)", maxExtractBytes)
		}
	}
	return b.expired()
}

type budgetWriter struct {
	w io.Writer
	b *extractBudget
}

func (bw budgetWriter) Write(p []byte) (int, error) {
	if e := bw.b.expired(); e != nil {
		return 0, e
	}
	n, err := bw.w.Write(p)
	if e := bw.b.written(int64(n)); e != nil {
		return n, e
	}
	return n, err
}

// pathDepth counts the members of a slash-separated archive path.
func pathDepth(name string) int {
	n := 0
	for _, part := range strings.Split(strings.ReplaceAll(name, "\\", "/"), "/") {
		if part != "" && part != "." {
			n++
		}
	}
	return n
}

func treeSize(root string) int64 {
	var total int64
	_ = filepath.WalkDir(root, func(_ string, entry os.DirEntry, err error) error {
		if err != nil || !entry.Type().IsRegular() {
			return nil
		}
		if info, e := entry.Info(); e == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

func extractError(format string, args ...any) error { return failure("ExtractError", format, args...) }
func trustedMember(root, name string) (string, error) {
	name = strings.ReplaceAll(name, "\\", "/")
	if strings.Contains(name, ":") || strings.HasPrefix(name, "/") {
		return "", extractError("archive member escapes extract dir: %s", name)
	}
	for _, p := range strings.Split(name, "/") {
		if p == ".." {
			return "", extractError("archive member escapes extract dir: %s", name)
		}
	}
	rel := filepath.FromSlash(name)
	if !filepath.IsLocal(rel) {
		return "", extractError("archive member escapes extract dir: %s", name)
	}
	abs, e := filepath.Abs(root)
	if e != nil {
		return "", e
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	} else if !os.IsNotExist(err) {
		return "", err
	}
	dest := filepath.Join(abs, rel)
	real, e := filepath.EvalSymlinks(filepath.Dir(dest))
	if e == nil {
		r, e := filepath.Rel(abs, real)
		if e != nil || !filepath.IsLocal(r) {
			return "", extractError("archive member escapes extract dir: %s", name)
		}
	}
	return dest, nil
}
func regularFiles(root string) ([]string, error) {
	out := []string{}
	stack := []string{root}
	for len(stack) > 0 {
		d := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		entries, e := os.ReadDir(d)
		if e != nil {
			return nil, e
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			p := filepath.Join(d, entry.Name())
			if entry.Type()&os.ModeSymlink != 0 {
				resolved, e := filepath.EvalSymlinks(p)
				if e != nil {
					return nil, e
				}
				rel, e := filepath.Rel(root, resolved)
				if e != nil || !filepath.IsLocal(rel) {
					return nil, extractError("extracted link escapes extract dir: %s", p)
				}
				continue
			}
			if entry.IsDir() {
				stack = append(stack, p)
			} else if entry.Type().IsRegular() {
				out = append(out, p)
			}
		}
	}
	return out, nil
}
func locateTree(root string) (object, error) {
	files, e := regularFiles(root)
	if e != nil {
		return nil, e
	}
	for _, p := range files {
		if !strings.Contains(filepath.Base(p), "app.asar") || !strings.EqualFold(filepath.Base(filepath.Dir(p)), "resources") {
			continue
		}
		resources := filepath.Dir(p)
		ls := ""
		for _, n := range []string{"language_server.exe", "language_server"} {
			v := filepath.Join(resources, "bin", n)
			if isFile(v) {
				ls = v
				break
			}
		}
		var unpacked any
		u := p + ".unpacked"
		if isDir(u) {
			unpacked = u
		}
		var server any
		if ls != "" {
			server = ls
		}
		return object{"app_root": filepath.Dir(resources), "asar": p, "unpacked_dir": unpacked, "ls_exe": server}, nil
	}
	return nil, nil
}
func find7z(tools string, offline bool) (string, error) {
	// Prefer a verified cached copy, then a logged unverified system 7z.
	// Bootstrap pinned tools only on Windows when downloads are allowed.
	seven := filepath.Join(tools, "7z-extra", "x64", "7za.exe")
	sha, e := hashFile(seven)
	if e != nil && !os.IsNotExist(e) {
		return "", e
	}
	if e == nil && sha == pinnedSHA256["x64/7za.exe"] {
		return seven, nil
	}
	if p, e := exec.LookPath("7z"); e == nil {
		logf("[*] using unverified system 7z (%s); no hash-pinned copy is cached", p)
		return p, nil
	}
	for _, p := range []string{`C:\Program Files\7-Zip\7z.exe`, `C:\Program Files (x86)\7-Zip\7z.exe`} {
		if isFile(p) {
			logf("[*] using unverified system 7z (%s); no hash-pinned copy is cached", p)
			return p, nil
		}
	}
	if runtime.GOOS != "windows" {
		return "", extractError("7-Zip not found; install the system 7z executable")
	}
	if offline {
		return "", extractError("7-Zip not found or cached tool failed its SHA-256 pin; install system 7z or provide the pinned cache (tool downloads disabled for local files)")
	}
	for _, n := range []string{"7zr.exe", "7z2501-extra.7z"} {
		p := filepath.Join(tools, n)
		sha, e := hashFile(p)
		if e != nil || sha != pinnedSHA256[n] {
			logf("[*] downloading pinned 7-Zip tool %s", n)
			if _, _, e = download("https://www.7-zip.org/a/"+n, p, nil, ""); e != nil {
				return "", e
			}
			sha, e = hashFile(p)
			if e != nil {
				return "", e
			}
			if sha != pinnedSHA256[n] {
				_ = os.Remove(p)
				return "", extractError("%s failed SHA-256 pin (got %.16s...)", n, sha)
			}
		}
	}
	sha, e = hashFile(seven)
	if e != nil || sha != pinnedSHA256["x64/7za.exe"] {
		if e = run7z(filepath.Join(tools, "7zr.exe"), filepath.Join(tools, "7z2501-extra.7z"), filepath.Join(tools, "7z-extra"), newExtractBudget()); e != nil {
			return "", e
		}
	}
	sha, e = hashFile(seven)
	if e != nil || sha != pinnedSHA256["x64/7za.exe"] {
		return "", extractError("bootstrapped 7za.exe missing or failed its SHA-256 pin")
	}
	return seven, nil
}

// sevenContext bounds an external 7z invocation by the shared extraction
// deadline (falling back to the whole-operation budget when none is given).
func sevenContext(b *extractBudget) (context.Context, context.CancelFunc, context.CancelCauseFunc) {
	deadline := time.Now().Add(maxExtractTime)
	if b != nil {
		deadline = b.deadline
	}
	base, stop := context.WithDeadline(context.Background(), deadline)
	ctx, cancel := context.WithCancelCause(base)
	return ctx, func() { stop() }, cancel
}

type cappedSink struct {
	cancel context.CancelFunc
	limit  int64
	used   int64
	data   bytes.Buffer
	err    error
}

// newCappedSink bounds captured process output; on overflow it cancels the
// command context and fails visibly instead of buffering unbounded output.
func newCappedSink(cancel context.CancelFunc, limit int64) *cappedSink {
	return &cappedSink{cancel: cancel, limit: limit}
}

func (s *cappedSink) Write(p []byte) (int, error) {
	if s.err != nil {
		return 0, s.err
	}
	if s.used+int64(len(p)) > s.limit {
		s.err = extractError("7z output exceeded the capture budget (limit %d bytes)", s.limit)
		s.cancel()
		return 0, s.err
	}
	s.used += int64(len(p))
	return s.data.Write(p)
}

func sevenOutput(ctx context.Context, cancel context.CancelCauseFunc, exe string, args ...string) ([]byte, error) {
	sink := newCappedSink(func() { cancel(nil) }, maxSevenOutputBytes)
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.Stdout, cmd.Stderr = sink, sink
	e := cmd.Run()
	if e != nil {
		if sink.err != nil {
			return nil, sink.err
		}
		if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.DeadlineExceeded) && !errors.Is(cause, context.Canceled) {
			return nil, cause
		}
		tail := sink.data.Bytes()
		if len(tail) > 400 {
			tail = tail[len(tail)-400:]
		}
		code := -1
		if x, ok := e.(*exec.ExitError); ok {
			code = x.ExitCode()
		}
		return nil, extractError("7z extraction failed (%d): %s", code, tail)
	}
	return sink.data.Bytes(), nil
}

// run7z extracts with an external 7z binary under the shared budget. The
// listing is a preflight: entry count, declared expanded bytes, per-entry
// size, nesting depth, links, and containment are checked before any
// extraction runs, and the declared total is reserved from the budget so
// later stages cannot oversubscribe it. During extraction the process is
// bounded by the deadline and a watchdog that kills it when the output tree
// grows past the reserved amount.
//
// Residual gap (plan open question 9): the watchdog polls at a fixed
// interval, so disk usage can overshoot the budget within one poll interval;
// a kernel-enforced quota would be required for a hard disk bound, and the
// bound also trusts that 7z's own listing reports honest sizes.
func run7z(exe, archive, out string, b *extractBudget) error {
	if e := os.MkdirAll(out, 0755); e != nil {
		return e
	}
	ctx, stop, cancel := sevenContext(b)
	defer stop()
	listing, e := sevenOutput(ctx, cancel, exe, "l", "-slt", "--", archive)
	if e != nil {
		return e
	}
	listed, e := checkSevenListing(string(listing), out, b)
	if e != nil {
		return e
	}
	b.bytes -= listed
	base := treeSize(out)
	exceeded := make(chan int64, 1)
	watchCtx, watchCancel := context.WithCancelCause(ctx)
	defer watchCancel(nil)
	stopWatch := watchExtractedBytes(watchCtx, out, base+listed, func(size int64) {
		exceeded <- size
		watchCancel(extractError("7z extraction wrote past the expanded bytes budget (limit %d bytes for this stage, observed %d bytes)", listed, size))
	})
	defer stopWatch()
	if _, e = sevenOutput(watchCtx, watchCancel, exe, "x", "-y", "-o"+out, "--", archive); e != nil {
		return e
	}
	if _, e = regularFiles(out); e != nil {
		return e
	}
	return b.expired()
}

// checkSevenListing preflights an external 7z stage against the budget from
// its `l -slt` listing and, if every limit passes, charges the declared
// entries and bytes. The returned total is the reserved expansion size.
func checkSevenListing(listing, out string, b *extractBudget) (int64, error) {
	scanner := bufio.NewScanner(strings.NewReader(listing))
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	inEntries := false
	var total, current int64
	previousPath := ""
	charge := func(name string, declared int64) error {
		if _, e := trustedMember(out, name); e != nil {
			return e
		}
		if e := b.entry(name, declared); e != nil {
			return e
		}
		total += declared
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "----------" {
			inEntries = true
			continue
		}
		if !inEntries {
			continue
		}
		switch {
		case strings.HasPrefix(line, "Path = "):
			if previousPath != "" {
				if b != nil && current > b.maxEntry {
					return 0, extractError("per-entry bytes budget exceeded (limit %d bytes)", b.maxEntry)
				}
				if e := charge(previousPath, current); e != nil {
					return 0, e
				}
			}
			previousPath = strings.TrimPrefix(line, "Path = ")
			current = 0
		case strings.HasPrefix(line, "Size = "):
			parsed, e := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "Size = ")), 10, 64)
			if e == nil && parsed > 0 {
				current = parsed
			}
		case strings.HasPrefix(line, "Symbolic Link = "), strings.HasPrefix(line, "Hard Link = "):
			return 0, extractError("7z archive contains unsupported links")
		}
	}
	if e := scanner.Err(); e != nil {
		return 0, e
	}
	if previousPath != "" {
		if b != nil && current > b.maxEntry {
			return 0, extractError("per-entry bytes budget exceeded (limit %d bytes)", b.maxEntry)
		}
		if e := charge(previousPath, current); e != nil {
			return 0, e
		}
	}
	if b != nil && total > b.bytes {
		return 0, extractError("archive declares %d expanded bytes past the expanded bytes budget (limit %d bytes per installer)", total, maxExtractBytes)
	}
	return total, nil
}

// watchExtractedBytes polls the output tree and reports the observed size
// once it grows past limit; the caller kills the process. Stop waits for the
// poller to exit.
func watchExtractedBytes(ctx context.Context, out string, limit int64, exceeded func(int64)) (stop func()) {
	halt := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(sevenWatchInterval)
		defer ticker.Stop()
		for {
			select {
			case <-halt:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				size := treeSize(out)
				if size > limit {
					exceeded(size)
					return
				}
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() { close(halt) })
		<-done
	}
}
func extractZIP(archive, out string, b *extractBudget) error {
	z, e := zip.OpenReader(archive)
	if e != nil {
		return extractError("zip extraction failed: %s", e)
	}
	defer func() { _ = z.Close() }()
	r, e := os.OpenRoot(out)
	if e != nil {
		return e
	}
	defer func() { _ = r.Close() }()
	for _, entry := range z.File {
		if _, e = trustedMember(out, entry.Name); e != nil {
			return e
		}
		if e = b.entry(entry.Name, int64(entry.UncompressedSize64)); e != nil {
			return e
		}
		name := filepath.FromSlash(strings.ReplaceAll(entry.Name, "\\", "/"))
		if entry.FileInfo().IsDir() {
			if e = r.MkdirAll(name, 0755); e != nil {
				return e
			}
			continue
		}
		if e = r.MkdirAll(filepath.Dir(name), 0755); e != nil {
			return e
		}
		src, e := entry.Open()
		if e != nil {
			return e
		}
		dst, e := r.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
		if e != nil {
			_ = src.Close()
			return e
		}
		_, copyErr := io.Copy(budgetWriter{w: dst, b: b}, src)
		srcErr := src.Close()
		dstErr := dst.Close()
		for _, err := range []error{copyErr, srcErr, dstErr} {
			if err != nil {
				return err
			}
		}
	}
	return b.expired()
}
func extractTAR(archive, out string, b *extractBudget) error {
	f, e := os.Open(archive)
	if e != nil {
		return e
	}
	defer func() { _ = f.Close() }()
	var reader io.Reader = f
	if strings.HasSuffix(strings.ToLower(archive), ".gz") || strings.HasSuffix(strings.ToLower(archive), ".tgz") {
		gz, e := gzip.NewReader(f)
		if e != nil {
			return extractError("tar extraction failed: %s", e)
		}
		defer func() { _ = gz.Close() }()
		reader = gz
	}
	r, e := os.OpenRoot(out)
	if e != nil {
		return e
	}
	defer func() { _ = r.Close() }()
	tr := tar.NewReader(reader)
	for {
		h, e := tr.Next()
		if e == io.EOF {
			return b.expired()
		}
		if e != nil {
			return extractError("tar extraction failed: %s", e)
		}
		if _, e = trustedMember(out, h.Name); e != nil {
			return e
		}
		if h.Typeflag == tar.TypeXGlobalHeader {
			continue
		}
		if e = b.entry(h.Name, h.Size); e != nil {
			return e
		}
		name := filepath.FromSlash(strings.ReplaceAll(h.Name, "\\", "/"))
		if e = r.MkdirAll(filepath.Dir(name), 0755); e != nil {
			return e
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if e = r.MkdirAll(name, 0755); e != nil {
				return e
			}
		case tar.TypeReg:
			dst, e := r.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
			if e != nil {
				return e
			}
			_, e = io.CopyN(budgetWriter{w: dst, b: b}, tr, h.Size)
			closeErr := dst.Close()
			if e != nil {
				return e
			}
			if closeErr != nil {
				return closeErr
			}
		case tar.TypeSymlink:
			link := strings.ReplaceAll(h.Linkname, "\\", "/")
			if filepath.IsAbs(link) || strings.Contains(link, ":") {
				return extractError("archive link escapes extract dir: %s", h.Name)
			}
			target := filepath.Clean(filepath.Join(filepath.Dir(name), filepath.FromSlash(link)))
			if !filepath.IsLocal(target) {
				return extractError("archive link escapes extract dir: %s", h.Name)
			}
			if e = r.Symlink(filepath.FromSlash(link), name); e != nil {
				return e
			}
		case tar.TypeLink:
			if _, e = trustedMember(out, h.Linkname); e != nil {
				return e
			}
			if e = r.Link(filepath.FromSlash(h.Linkname), name); e != nil {
				return e
			}
		default:
			return extractError("unsupported tar member type %d: %s", h.Typeflag, h.Name)
		}
	}
}
func extractAR(archive, out string, b *extractBudget) (string, error) {
	f, e := os.Open(archive)
	if e != nil {
		return "", e
	}
	defer func() { _ = f.Close() }()
	magic := make([]byte, 8)
	if _, e = io.ReadFull(f, magic); e != nil || string(magic) != "!<arch>\n" {
		return "", extractError("deb has invalid ar header")
	}
	for {
		h := make([]byte, 60)
		_, e = io.ReadFull(f, h)
		if e == io.EOF {
			break
		}
		if e != nil {
			return "", e
		}
		if string(h[58:]) != "`\n" {
			return "", extractError("deb has invalid ar member header")
		}
		n, e := strconv.ParseInt(strings.TrimSpace(string(h[48:58])), 10, 64)
		if e != nil || n < 0 {
			return "", extractError("deb has invalid ar member size")
		}
		name := strings.TrimSuffix(strings.TrimSpace(string(h[:16])), "/")
		if strings.HasPrefix(name, "data.tar") {
			p, e := trustedMember(out, name)
			if e != nil {
				return "", e
			}
			if e = b.entry(name, n); e != nil {
				return "", e
			}
			dst, e := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if e != nil {
				return "", e
			}
			_, e = io.CopyN(budgetWriter{w: dst, b: b}, f, n)
			closeErr := dst.Close()
			if e != nil {
				return "", e
			}
			if closeErr != nil {
				return "", closeErr
			}
			return p, nil
		}
		if _, e = io.CopyN(io.Discard, f, n+n%2); e != nil {
			return "", e
		}
	}
	return "", extractError("deb has no data.tar.* member")
}
func archiveKind(p string) string {
	p = strings.ToLower(p)
	if strings.HasSuffix(p, ".tar.gz") || strings.HasSuffix(p, ".tgz") {
		return "tar.gz"
	}
	return filepath.Ext(p)
}
func archiveStem(p string) string {
	name := filepath.Base(p)
	if archiveKind(p) == "tar.gz" {
		if strings.HasSuffix(strings.ToLower(name), ".tgz") {
			return name[:len(name)-4]
		}
		return name[:len(name)-7]
	}
	return strings.TrimSuffix(name, filepath.Ext(name))
}
func extractArchive(kind, installer, out, tools string, b *extractBudget) error {
	switch kind {
	case "tar.gz":
		return extractTAR(installer, out, b)
	case ".zip":
		return extractZIP(installer, out, b)
	case ".deb":
		stage := filepath.Join(out, "_ar")
		if e := os.MkdirAll(stage, 0755); e != nil {
			return e
		}
		data, e := extractAR(installer, stage, b)
		if e != nil {
			return e
		}
		if strings.HasSuffix(data, ".tar") || strings.HasSuffix(data, ".gz") {
			return extractTAR(data, out, b)
		}
		seven, e := find7z(tools, b.offline)
		if e != nil {
			return e
		}
		if e = run7z(seven, data, out, b); e != nil {
			return e
		}
		tree, e := locateTree(out)
		if e != nil || tree != nil {
			return e
		}
		files, e := regularFiles(out)
		if e != nil {
			return e
		}
		for _, p := range files {
			if strings.HasSuffix(p, ".tar") {
				return extractTAR(p, out, b)
			}
		}
		return extractError("deb data.tar.* did not yield an app tree")
	default:
		seven, e := find7z(tools, b.offline)
		if e != nil {
			return e
		}
		if e = run7z(seven, installer, out, b); e != nil {
			return e
		}
		if kind == ".dmg" {
			tree, e := locateTree(out)
			if e != nil || tree != nil {
				return e
			}
			files, e := regularFiles(out)
			if e != nil {
				return e
			}
			for _, p := range files {
				n := strings.ToLower(filepath.Base(p))
				if strings.HasSuffix(n, ".hfs") || strings.HasSuffix(n, ".dmg") || strings.Contains(n, "hfs") {
					return run7z(seven, p, filepath.Join(out, "_dmg_inner"), b)
				}
			}
		}
		return nil
	}
}
func extractInstaller(installer, extractRoot, tools, digest string) (object, error) {
	return extractInstallerBudgeted(installer, extractRoot, tools, digest, newExtractBudget())
}
func extractInstallerBudgeted(installer, extractRoot, tools, digest string, b *extractBudget) (object, error) {
	kind := archiveKind(installer)
	switch kind {
	case ".exe", ".zip", ".deb", ".dmg", "tar.gz":
	default:
		return nil, extractError("unsupported installer format: %s", filepath.Base(installer))
	}
	if len(digest) != 64 || strings.ContainsAny(digest, "/\\:") {
		return nil, extractError("invalid installer SHA-256")
	}
	root := filepath.Join(extractRoot, digest)
	if e := os.MkdirAll(root, 0755); e != nil {
		return nil, e
	}
	app := filepath.Join(root, archiveStem(installer)+"-app")
	if !isFile(filepath.Join(app, "done")) {
		if e := removeScratch(root, app); e != nil {
			return nil, e
		}
		if e := os.MkdirAll(app, 0755); e != nil {
			return nil, e
		}
		logf("[*] extracting installer -> %s/", filepath.Base(app))
		if e := extractArchive(kind, installer, app, tools, b); e != nil {
			return nil, e
		}
		if e := os.WriteFile(filepath.Join(app, "done"), nil, 0600); e != nil {
			return nil, e
		}
	}
	tree, e := locateTree(app)
	if e != nil || tree != nil {
		return tree, e
	}
	if kind != ".exe" {
		return nil, extractError("%s yielded no resources/app.asar", filepath.Base(installer))
	}
	files, e := regularFiles(app)
	if e != nil {
		return nil, e
	}
	inner := ""
	for _, p := range files {
		if strings.Contains(filepath.Base(p), ".7z") {
			inner = p
			break
		}
	}
	if inner == "" {
		return nil, extractError("installer yielded neither resources/app.asar nor an inner .7z")
	}
	out := filepath.Join(root, archiveStem(installer)+"-inner")
	if !isFile(filepath.Join(out, "done")) {
		if e = removeScratch(root, out); e != nil {
			return nil, e
		}
		seven, e := find7z(tools, b.offline)
		if e != nil {
			return nil, e
		}
		if e = run7z(seven, inner, out, b); e != nil {
			return nil, e
		}
		if e = os.WriteFile(filepath.Join(out, "done"), nil, 0600); e != nil {
			return nil, e
		}
	}
	tree, e = locateTree(out)
	if e != nil {
		return nil, e
	}
	if tree == nil {
		return nil, extractError("no resources/app.asar after extracting the embedded app archive")
	}
	return tree, nil
}
func removeScratch(root, path string) error {
	abs, e := filepath.Abs(root)
	if e != nil {
		return e
	}
	target, e := filepath.Abs(path)
	if e != nil {
		return e
	}
	rel, e := filepath.Rel(abs, target)
	if e != nil || rel == "." || !filepath.IsLocal(rel) {
		return fmt.Errorf("refusing scratch removal outside %s: %s", root, path)
	}
	r, e := os.OpenRoot(abs)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	defer func() { _ = r.Close() }()
	// A scanner or indexer can briefly hold a freshly extracted file, which makes
	// Windows report the directory as not empty; a short retry outlasts it.
	for attempt := 1; ; attempt++ {
		e = r.RemoveAll(rel)
		if e == nil || attempt == scratchRemovalAttempts {
			return e
		}
		time.Sleep(time.Duration(attempt) * 50 * time.Millisecond)
	}
}

const scratchRemovalAttempts = 5
