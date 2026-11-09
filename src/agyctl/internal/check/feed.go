package check

import (
	"agyctl/internal/layout"
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const userAgent = "agyctl-update-check/1.0"
const hubBase = "https://storage.googleapis.com/antigravity-public/antigravity-hub"
const insidersBase = "https://storage.googleapis.com/antigravity-public/insiders"

var releaseURLs = map[string]string{"hub": "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/releases"}

type httpError struct {
	status int
	url    string
}

func (e *httpError) Error() string {
	return fmt.Sprintf("HTTP Error %d: %s", e.status, http.StatusText(e.status))
}
func request(method, rawURL string, timeout time.Duration) (*http.Response, error) {
	req, e := http.NewRequest(method, rawURL, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("User-Agent", userAgent)
	res, e := (&http.Client{Timeout: timeout}).Do(req)
	if e != nil {
		return nil, e
	}
	if res.StatusCode >= 400 {
		_ = res.Body.Close()
		return nil, &httpError{res.StatusCode, rawURL}
	}
	return res, nil
}
func listReleases(channel string) ([]object, error) {
	raw, ok := releaseURLs[channel]
	if !ok {
		return nil, failure("ValueError", "channel %s has no releases API", channel)
	}
	res, e := request("GET", raw, 30*time.Second)
	if e != nil {
		return nil, e
	}
	defer func() { _ = res.Body.Close() }()
	var parsed any
	if e = json.NewDecoder(res.Body).Decode(&parsed); e != nil {
		return nil, e
	}
	items, ok := parsed.([]any)
	if !ok {
		return nil, failure("ValueError", "releases response is not a list")
	}
	out := []object{}
	for _, item := range items {
		r, ok := item.(map[string]any)
		if !ok {
			return nil, failure("ValueError", "release entry is not an object")
		}
		if str(r["version"]) != "" && str(r["execution_id"]) != "" {
			out = append(out, object{"version": str(r["version"]), "execution_id": str(r["execution_id"])})
		}
	}
	return out, nil
}
func pickRelease(rows []object, version string) (object, error) {
	for _, r := range rows {
		if version == "" || r["version"] == version {
			return r, nil
		}
	}
	return nil, failure("LookupError", "version %s not in feed (channel has %d releases)", version, len(rows))
}
func assetURL(config layout.Config, channel, version, execution, platform string) (string, error) {
	if channel != "hub" {
		return "", failure("ValueError", "unsupported release channel: %s", channel)
	}
	target, err := config.FeedTarget(platform)
	if err != nil {
		return "", err
	}
	name := "Antigravity.tar.gz"
	switch target.GOOS {
	case "windows":
		name = "Antigravity-x64.exe"
	case "darwin":
		name = "Antigravity.dmg"
	}
	return hubBase + "/" + version + "-" + execution + "/" + target.ReleaseDirectory + "/" + name, nil
}
func ymlScalar(s string) any {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	if len(s) >= 2 && s[0] == s[len(s)-1] && (s[0] == '\'' || s[0] == '"') {
		return s[1 : len(s)-1]
	}
	if n, e := strconv.ParseInt(s, 10, 64); e == nil {
		return n
	}
	return s
}
func parseYAML(text string) (object, error) {
	out := object{"version": nil, "files": []object{}, "path": nil, "sha512": nil, "size": nil}
	files := []object{}
	var current object
	for _, raw := range strings.Split(text, "\n") {
		s := strings.TrimLeft(raw, " \t")
		if strings.TrimSpace(s) == "" || strings.HasPrefix(s, "#") {
			continue
		}
		indent := len(raw) - len(s)
		if strings.HasPrefix(s, "- ") {
			current = object{}
			files = append(files, current)
			key, val, ok := strings.Cut(s[2:], ":")
			if ok {
				current[strings.TrimSpace(key)] = ymlScalar(val)
			}
			continue
		}
		key, val, _ := strings.Cut(s, ":")
		key = strings.TrimSpace(key)
		v := ymlScalar(val)
		if indent >= 2 && current != nil && key != "" {
			current[key] = v
			continue
		}
		current = nil
		switch key {
		case "version", "path", "sha512", "size":
			out[key] = v
		}
	}
	if str(out["version"]) == "" {
		return nil, failure("ValueError", "electron-updater yaml missing version")
	}
	out["version"] = str(out["version"])
	out["files"] = files
	return out, nil
}
func quoteAsset(rel string) string {
	parts := strings.Split(rel, "/")
	for i, p := range parts {
		parts[i] = strings.ReplaceAll(url.QueryEscape(p), "+", "%20")
	}
	return strings.Join(parts, "/")
}
func insidersAsset(platform string, yml object) (object, error) {
	files := objects(yml["files"])
	var chosen object
	switch platform {
	case "linux-x64":
		for _, f := range files {
			if strings.HasSuffix(str(f["url"]), ".deb") {
				chosen = f
				break
			}
		}
		if chosen == nil {
			return nil, failure("LookupError", "insiders linux-x64 yaml has no .deb")
		}
	default:
		if len(files) > 0 {
			chosen = files[0]
		} else if str(yml["path"]) != "" {
			chosen = object{"url": yml["path"], "sha512": yml["sha512"], "size": yml["size"]}
		} else {
			return nil, failure("LookupError", "insiders yaml for %s has no files", platform)
		}
	}
	rel := str(chosen["url"])
	if rel == "" {
		rel = str(yml["path"])
	}
	if rel == "" {
		return nil, failure("LookupError", "insiders yaml for %s has no asset path", platform)
	}
	same := object{}
	if rel == str(yml["path"]) {
		same = yml
	}
	size, ok := chosen["size"]
	if !ok {
		size = same["size"]
	}
	sha, ok := chosen["sha512"]
	if !ok {
		sha = same["sha512"]
	}
	return object{"version": yml["version"], "url": insidersBase + "/" + quoteAsset(rel), "size": size, "sha512": sha}, nil
}
func insidersYAML(config layout.Config, platform string, cache map[string]object) (object, error) {
	if v, ok := cache[platform]; ok {
		return v, nil
	}
	target, e := config.FeedTarget(platform)
	if e != nil {
		return nil, e
	}
	res, e := request("GET", insidersBase+"/"+target.ChannelFile, 30*time.Second)
	if e != nil {
		if h, ok := e.(*httpError); ok && h.status == 404 {
			cache[platform] = nil
			return nil, nil
		}
		return nil, e
	}
	defer func() { _ = res.Body.Close() }()
	b, e := io.ReadAll(res.Body)
	if e != nil {
		return nil, e
	}
	y, e := parseYAML(string(b))
	if e == nil {
		cache[platform] = y
	}
	return y, e
}
func resolveCell(config layout.Config, channel, platform, version string, release object, cache map[string]object) (object, error) {
	if channel != "insiders" {
		if release == nil {
			return nil, failure("ValueError", "hub_release is required for hub cells")
		}
		u, e := assetURL(config, channel, str(release["version"]), str(release["execution_id"]), platform)
		if e != nil {
			return nil, e
		}
		return object{"channel": channel, "platform": platform, "version": release["version"], "execution_id": release["execution_id"], "url": u}, nil
	}
	y, e := insidersYAML(config, platform, cache)
	if e != nil {
		return nil, e
	}
	if y == nil {
		return nil, failure("LookupError", "insiders yaml missing for %s", platform)
	}
	row, e := insidersAsset(platform, y)
	if e != nil {
		return nil, e
	}
	row["channel"] = "insiders"
	row["platform"] = platform
	return row, nil
}

func verifyDownload(path, expectedSHA string, expectedSize any, expected512 string) (string, int64, error) {
	f, e := os.Open(path)
	if e != nil {
		return "", 0, e
	}
	defer func() { _ = f.Close() }()
	h, h512 := sha256.New(), sha512.New()
	n, e := io.Copy(io.MultiWriter(h, h512), f)
	if e != nil {
		return "", 0, e
	}
	sha := hex.EncodeToString(h.Sum(nil))
	if expectedSHA == "" || sha != expectedSHA {
		return "", n, failure("OSError", "cached installer SHA-256 does not match archive manifest; download again")
	}
	if expectedSize != nil && n != num(expectedSize) {
		return "", n, failure("OSError", "cached installer size does not match release metadata")
	}
	if expected512 != "" && base64.StdEncoding.EncodeToString(h512.Sum(nil)) != expected512 {
		return "", n, failure("OSError", "cached installer SHA-512 does not match release metadata")
	}
	return sha, n, nil
}

// The total budget bounds the whole download including the headers phase; it
// is generous because a slow-but-progressing installer must still finish.
const downloadTotalBudget = 15 * time.Minute

// The idle budget resets on every received chunk, so a stalled connection
// aborts long before the total budget is spent holding it open.
const downloadIdleBudget = 60 * time.Second

// downloadByteBudget bounds a download whose size the release metadata does
// not record; a hostile endpoint must not fill the scratch directory. Hub and
// Insiders installers are far below it.
const downloadByteBudget int64 = 2 << 30

type downloadBudgets struct {
	total, idle time.Duration
	bytes       int64
}

func download(rawURL, dest string, size any, sha512sum string) (string, int64, error) {
	return downloadBudgeted(rawURL, dest, size, sha512sum, downloadBudgets{total: downloadTotalBudget, idle: downloadIdleBudget, bytes: downloadByteBudget})
}

// downloadBudgeted writes the response into dest+.part and renames it into
// place only after size and hash verification, so an interrupted download
// never publishes into the reusable downloads store.
func downloadBudgeted(rawURL, dest string, size any, sha512sum string, budgets downloadBudgets) (string, int64, error) {
	if e := os.MkdirAll(filepath.Dir(dest), 0755); e != nil {
		return "", 0, e
	}
	base, stopBase := context.WithDeadline(context.Background(), time.Now().Add(budgets.total))
	defer stopBase()
	ctx, cancel := context.WithCancelCause(base)
	defer cancel(nil)
	stalled := failure("TimeoutError", "download stalled: no data for %s", budgets.idle)
	idleTimer := time.AfterFunc(budgets.idle, func() { cancel(stalled) })
	defer idleTimer.Stop()
	req, e := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	if e != nil {
		return "", 0, e
	}
	req.Header.Set("User-Agent", userAgent)
	res, e := (&http.Client{}).Do(req)
	if e != nil {
		return "", 0, budgetError(ctx, e, budgets)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode >= 400 {
		return "", 0, &httpError{res.StatusCode, rawURL}
	}
	if size == nil && res.ContentLength >= 0 {
		size = res.ContentLength
	}
	limit := budgets.bytes
	if size != nil {
		if num(size) > limit {
			return "", 0, failure("OSError", "download size %d exceeds the %d byte limit", num(size), limit)
		}
		limit = num(size)
	}
	part := dest + ".part"
	f, e := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if e != nil {
		return "", 0, e
	}
	defer func() { _ = os.Remove(part) }()
	defer func() { _ = f.Close() }()
	// One byte past the limit detects an oversized body without reading it to
	// the end.
	body := io.LimitReader(res.Body, limit+1)
	h, h512 := sha256.New(), sha512.New()
	buf := make([]byte, 64<<10)
	var n int64
	oversized := false
	for {
		idleTimer.Reset(budgets.idle)
		read, readErr := body.Read(buf)
		if read > 0 {
			if n+int64(read) > limit {
				oversized = true
				break
			}
			if _, e = io.MultiWriter(f, h, h512).Write(buf[:read]); e != nil {
				return "", n, e
			}
			n += int64(read)
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return "", n, budgetError(ctx, readErr, budgets)
		}
	}
	closeErr := f.Close()
	if closeErr != nil {
		return "", n, closeErr
	}
	if oversized {
		if size == nil {
			return "", n, failure("OSError", "download exceeded the %d byte limit", limit)
		}
		return "", n, failure("OSError", "download exceeded the expected size %d — refusing to publish a truncated artifact", num(size))
	}
	if size != nil && n != num(size) {
		return "", n, failure("OSError", "download truncated: got %d bytes, expected %d", n, num(size))
	}
	if sha512sum != "" && base64.StdEncoding.EncodeToString(h512.Sum(nil)) != sha512sum {
		return "", n, failure("OSError", "download SHA-512 does not match release metadata")
	}
	if e = os.Rename(part, dest); e != nil {
		return "", n, e
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// budgetError maps a context cancellation to its cause: the idle watchdog
// reports a stall, the deadline reports the total budget, other errors pass
// through unchanged.
func budgetError(ctx context.Context, cause error, budgets downloadBudgets) error {
	var stall error
	if ctx.Err() != nil {
		stall = context.Cause(ctx)
	}
	if stall != nil && !errors.Is(stall, context.DeadlineExceeded) {
		return stall
	}
	if errors.Is(cause, context.DeadlineExceeded) || (ctx.Err() != nil && errors.Is(ctx.Err(), context.DeadlineExceeded)) {
		return failure("TimeoutError", "download exceeded the total budget of %s", budgets.total)
	}
	return cause
}
