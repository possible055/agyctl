// Package patchlock holds the shared mutation lock for native patching
// features that operate on the same tool home. All features serialize on the
// same lock file names and the same lock order: the operation lock
// (limit-operation.lock) is acquired before the short-lived state-store lock
// (store.lock), never the reverse. The shared names are deliberate: separate
// per-feature lock files could not exclude two features from racing on the
// same installation, and the existing name keeps old CLIs compatible.
package patchlock

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const (
	// OperationLockName is the shared mutation lock for all native patch
	// features using this tool home.
	OperationLockName = "limit-operation.lock"
	// StoreLockName guards the load → mutate → persist critical section of a
	// state manifest and must never be held during backups, patch
	// preparation, or binary replacement.
	StoreLockName = "store.lock"
	StoreLockWait = 5 * time.Second
	operationWait = 250 * time.Millisecond
)

// Lock ordering and stale-lock policy for the tool home: neither lock is
// removed automatically while contended; a stale lock must be resolved
// explicitly by the operator.
type fileLock struct {
	path string
	file *os.File
	info os.FileInfo
}

func createLock(path string, owner any) (lock *fileLock, err error) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, file.Close(), os.Remove(path))
		}
	}()
	data, err := json.Marshal(owner)
	if err != nil {
		return nil, err
	}
	if _, err = file.Write(append(data, '\n')); err != nil {
		return nil, err
	}
	if err = file.Sync(); err != nil {
		return nil, err
	}
	var info os.FileInfo
	if info, err = file.Stat(); err != nil {
		return nil, err
	}
	return &fileLock{path: path, file: file, info: info}, nil
}

func (l *fileLock) release() error {
	closeErr := l.file.Close()
	info, statErr := os.Lstat(l.path)
	var removeErr error
	switch {
	case errors.Is(statErr, os.ErrNotExist):
		removeErr = nil
	case statErr != nil:
		removeErr = statErr
	case !os.SameFile(l.info, info):
		removeErr = errors.New("lock ownership changed; refusing to remove another owner's lock")
	default:
		if removeErr = os.Remove(l.path); errors.Is(removeErr, os.ErrNotExist) {
			removeErr = nil
		}
	}
	return errors.Join(closeErr, removeErr)
}

// On Windows a lock file in its delete-pending window rejects a new exclusive
// create with ERROR_ACCESS_DENIED instead of the expected already-exists
// error, so both are treated as contention and retried until the deadline.
func acquireStoreLock(directory string) (*fileLock, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(directory, StoreLockName)
	deadline := time.Now().Add(StoreLockWait)
	for {
		lock, err := createLock(path, map[string]any{"pid": os.Getpid(), "at": time.Now().UTC().Format(time.RFC3339)})
		if err == nil {
			return lock, nil
		}
		if !errors.Is(err, os.ErrExist) && !errors.Is(err, os.ErrPermission) {
			return nil, err
		}
		if !time.Now().Before(deadline) {
			return nil, fmt.Errorf("the state store lock %s is held by another limit or tool-output operation; no records were written — retry once the other command finishes", path)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

type StoreLock struct{ lock *fileLock }

// AcquireStoreLock takes the short-lived state-store lock for the load →
// mutate → persist critical section of a state manifest.
func AcquireStoreLock(directory string) (*StoreLock, error) {
	lock, err := acquireStoreLock(directory)
	if err != nil {
		return nil, err
	}
	return &StoreLock{lock: lock}, nil
}

func (s *StoreLock) Release() error {
	if s == nil || s.lock == nil {
		return nil
	}
	return s.lock.release()
}

type Operation struct {
	id   string
	lock *fileLock
}

func NewOperationID() string {
	buffer := make([]byte, 8)
	_, _ = rand.Read(buffer)
	return hex.EncodeToString(buffer)
}

// BeginOperation takes the shared mutation lock for one mutating command. The
// lock lives in directory under the shared OperationLockName and is held for
// the whole operation, including backups and binary replacement. An empty id
// gets a fresh operation id; a non-empty id resumes the id recorded in a
// prepare record.
func BeginOperation(directory, command, id string) (*Operation, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	if id == "" {
		id = NewOperationID()
	}
	path := filepath.Join(directory, OperationLockName)
	owner := map[string]any{"id": id, "pid": os.Getpid(), "command": command, "at": time.Now().UTC().Format(time.RFC3339)}
	deadline := time.Now().Add(operationWait)
	for {
		lock, err := createLock(path, owner)
		if err == nil {
			return &Operation{id: id, lock: lock}, nil
		}
		if errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("another limit or tool-output operation owns %s; no changes were made — wait for it to finish and retry; if no agyctl patching command is running the lock is stale and must be resolved explicitly", path)
		}
		if !errors.Is(err, os.ErrPermission) || !time.Now().Before(deadline) {
			return nil, err
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (o *Operation) ID() string {
	if o == nil {
		return ""
	}
	return o.id
}

func (o *Operation) Release() error {
	if o == nil || o.lock == nil {
		return nil
	}
	return o.lock.release()
}
