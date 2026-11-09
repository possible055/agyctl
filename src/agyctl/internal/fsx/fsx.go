package fsx

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

var ErrRolledBack = errors.New("replacement failed and operation-start bytes were restored")
var ErrRollbackFailed = errors.New("replacement failed and rollback could not be verified")

func SHA256(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func Hash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// EnsureBackup exclusively creates a verified copy and never replaces existing data.
func EnsureBackup(source, target, expectedSHA string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if SHA256(data) != expectedSHA {
		return errors.New("installed binary changed before backup — refusing")
	}
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	if err == nil {
		_, writeErr := f.Write(data)
		syncErr := f.Sync()
		closeErr := f.Close()
		if joined := errors.Join(writeErr, syncErr, closeErr); joined != nil {
			return joined
		}
	}
	sha, err := Hash(target)
	if err != nil {
		return err
	}
	if sha != expectedSHA {
		return fmt.Errorf("backup checksum mismatch; preserved without overwriting: %s", target)
	}
	return nil
}

func stage(path string, data []byte, mode os.FileMode) (string, error) {
	f, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return "", err
	}
	name := f.Name()
	_, writeErr := f.Write(data)
	chmodErr := f.Chmod(mode.Perm())
	syncErr := f.Sync()
	closeErr := f.Close()
	if err = errors.Join(writeErr, chmodErr, syncErr, closeErr); err != nil {
		return name, err
	}
	sha, err := Hash(name)
	if err != nil {
		return name, err
	}
	if sha != SHA256(data) {
		return name, errors.New("staged file checksum mismatch — refusing")
	}
	return name, nil
}

func AtomicWrite(path string, data []byte, mode os.FileMode) error {
	tmp, err := stage(path, data, mode)
	if tmp != "" {
		defer func() { _ = os.Remove(tmp) }()
	}
	if err != nil {
		return err
	}
	return replace(tmp, path)
}

// ReplaceVerified checks both sides of a same-directory replacement, refusing drift.
func ReplaceVerified(path string, data []byte, expectedCurrent string) (string, error) {
	return replaceVerified(path, data, expectedCurrent, Hash, replace)
}

func replaceVerified(path string, data []byte, expectedCurrent string, hashFile func(string) (string, error), replaceFile func(string, string) error) (string, error) {
	original, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if SHA256(original) != expectedCurrent {
		return "", errors.New("installed binary changed before staging — refusing")
	}
	stat, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	tmp, err := stage(path, data, stat.Mode())
	if tmp != "" {
		defer func() { _ = os.Remove(tmp) }()
	}
	if err != nil {
		return "", err
	}
	if err = os.Chtimes(tmp, stat.ModTime(), stat.ModTime()); err != nil {
		return "", err
	}
	recovery, err := stage(path+".recovery", original, stat.Mode())
	keepRecovery := false
	if recovery != "" {
		defer func() {
			if !keepRecovery {
				_ = os.Remove(recovery)
			}
		}()
	}
	if err != nil {
		return "", err
	}
	if err = os.Chtimes(recovery, stat.ModTime(), stat.ModTime()); err != nil {
		return "", err
	}
	sha, err := hashFile(path)
	if err != nil {
		return "", err
	}
	if sha != expectedCurrent {
		return "", errors.New("installed binary changed before replacement — refusing")
	}
	if err = replaceFile(tmp, path); err != nil {
		return "", err
	}
	sha, err = hashFile(path)
	expected := SHA256(data)
	if err == nil && sha == expected {
		return expected, nil
	}
	verificationErr := err
	if verificationErr == nil {
		verificationErr = errors.New("post-write whole-file verification failed")
	}
	keepRecovery = true
	rollbackFailed := func(cause error) (string, error) {
		return "", fmt.Errorf("%w: %w; recovery copy preserved: %s", ErrRollbackFailed, errors.Join(verificationErr, cause), recovery)
	}
	if err != nil {
		return rollbackFailed(err)
	}
	stable, err := hashFile(path)
	if err != nil {
		return rollbackFailed(err)
	}
	if stable != sha {
		return rollbackFailed(errors.New("installed binary changed after verification failure — refusing to overwrite concurrent changes"))
	}
	recoveryHash, err := Hash(recovery)
	if err != nil || recoveryHash != expectedCurrent {
		return rollbackFailed(errors.Join(err, errors.New("operation-start recovery copy did not verify")))
	}
	stable, err = hashFile(path)
	if err != nil || stable != sha {
		return rollbackFailed(errors.Join(err, errors.New("installed binary changed before rollback — refusing to overwrite concurrent changes")))
	}
	// Keep the verified recovery copy intact if replacing or verifying the
	// restoration fails; the replacement consumes only this second stage.
	restore, err := stage(path, original, stat.Mode())
	if restore != "" {
		defer func() { _ = os.Remove(restore) }()
	}
	if err != nil {
		return rollbackFailed(err)
	}
	if err = os.Chtimes(restore, stat.ModTime(), stat.ModTime()); err != nil {
		return rollbackFailed(err)
	}
	stable, err = hashFile(path)
	if err != nil || stable != sha {
		return rollbackFailed(errors.Join(err, errors.New("installed binary changed while staging rollback — refusing to overwrite concurrent changes")))
	}
	if err = replaceFile(restore, path); err != nil {
		return rollbackFailed(err)
	}
	restored, err := hashFile(path)
	if err != nil || restored != expectedCurrent {
		return rollbackFailed(errors.Join(err, errors.New("restored whole-file checksum did not verify")))
	}
	keepRecovery = false
	return "", fmt.Errorf("%w: %w", ErrRolledBack, verificationErr)
}
