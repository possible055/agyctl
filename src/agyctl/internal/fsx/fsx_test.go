package fsx

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agyctl/internal/testutil"
)

func TestExclusiveBackupAndReplaceDriftGuard(t *testing.T) {
	directory := testutil.TempDir(t)
	source := filepath.Join(directory, "language_server.exe")
	backup := source + ".orig"
	original := []byte("trusted original")
	stale := []byte("older original")
	if err := os.WriteFile(source, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backup, stale, 0600); err != nil {
		t.Fatal(err)
	}
	err := EnsureBackup(source, backup, SHA256(original))
	if err == nil || !strings.Contains(err.Error(), "preserved without overwriting") {
		t.Fatalf("stale backup error = %v", err)
	}
	if actual, err := os.ReadFile(backup); err != nil || !bytes.Equal(actual, stale) {
		t.Fatal("existing backup was modified")
	}
	immutable := filepath.Join(directory, "versioned.orig")
	if err = EnsureBackup(source, immutable, SHA256(original)); err != nil {
		t.Fatal(err)
	}
	if err = EnsureBackup(source, immutable, SHA256(original)); err != nil {
		t.Fatal(err)
	}
	newer := []byte("new application build")
	if err = os.WriteFile(source, newer, 0600); err != nil {
		t.Fatal(err)
	}
	_, err = ReplaceVerified(source, []byte("patched"), SHA256(original))
	if err == nil || err.Error() != "installed binary changed before staging — refusing" {
		t.Fatalf("drift guard error = %v", err)
	}
	if actual, err := os.ReadFile(source); err != nil || !bytes.Equal(actual, newer) {
		t.Fatal("drift guard overwrote the newer build")
	}
	patched := []byte("patched newer build")
	sha, err := ReplaceVerified(source, patched, SHA256(newer))
	if err != nil {
		t.Fatal(err)
	}
	if sha != SHA256(patched) {
		t.Fatalf("replacement SHA = %s", sha)
	}
	if actual, err := os.ReadFile(immutable); err != nil || !bytes.Equal(actual, original) {
		t.Fatal("immutable backup changed during replacement")
	}
}

func TestPostWriteVerificationRecovery(t *testing.T) {
	for _, row := range []struct {
		name                              string
		drift, unreadable, restoreFailure bool
		want                              error
	}{
		{name: "stable corruption is restored", want: ErrRolledBack},
		{name: "concurrent drift is preserved", drift: true, want: ErrRollbackFailed},
		{name: "unreadable destination is not overwritten", unreadable: true, want: ErrRollbackFailed},
		{name: "failed restoration keeps recovery copy", restoreFailure: true, want: ErrRollbackFailed},
	} {
		t.Run(row.name, func(t *testing.T) {
			path := filepath.Join(testutil.TempDir(t), "language_server.exe")
			original := []byte("operation-start original")
			if err := os.WriteFile(path, original, 0600); err != nil {
				t.Fatal(err)
			}
			mtime := time.Unix(1700000000, 0)
			if err := os.Chtimes(path, mtime, mtime); err != nil {
				t.Fatal(err)
			}
			before, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			writes, reads := 0, 0
			hash := func(filename string) (string, error) {
				reads++
				if reads == 2 && row.unreadable {
					return "", os.ErrPermission
				}
				if reads == 3 && row.drift {
					if err := os.WriteFile(path, []byte("concurrent writer"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				return Hash(filename)
			}
			replaceFile := func(source, target string) error {
				writes++
				if writes == 1 {
					return os.WriteFile(target, []byte("corrupt write"), 0600)
				}
				if row.restoreFailure {
					return os.ErrPermission
				}
				return replace(source, target)
			}
			_, err = replaceVerified(path, []byte("desired patch"), SHA256(original), hash, replaceFile)
			if !errors.Is(err, row.want) {
				t.Fatalf("error = %v, want %v", err, row.want)
			}
			data, readErr := os.ReadFile(path)
			if readErr != nil {
				t.Fatal(readErr)
			}
			copies, globErr := filepath.Glob(path + ".recovery.*.tmp")
			if globErr != nil {
				t.Fatal(globErr)
			}
			if row.want == ErrRolledBack {
				after, statErr := os.Stat(path)
				if statErr != nil {
					t.Fatal(statErr)
				}
				if !bytes.Equal(data, original) || after.Mode().Perm() != before.Mode().Perm() || !after.ModTime().Equal(before.ModTime()) || len(copies) != 0 {
					t.Fatalf("restored content=%q mode=%v mtime=%v recovery=%v", data, after.Mode(), after.ModTime(), copies)
				}
			} else {
				wantData := "corrupt write"
				if row.drift {
					wantData = "concurrent writer"
				}
				if string(data) != wantData || len(copies) != 1 || !strings.Contains(err.Error(), copies[0]) {
					t.Fatalf("destination=%q recovery=%v error=%v", data, copies, err)
				}
				copyData, copyErr := os.ReadFile(copies[0])
				if copyErr != nil || !bytes.Equal(copyData, original) {
					t.Fatalf("recovery=%q error=%v", copyData, copyErr)
				}
			}
		})
	}
}
