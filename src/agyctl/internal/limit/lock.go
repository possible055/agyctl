package limit

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

// Lock ordering for the limit state directory: the operation lock
// (limit-operation.lock) is acquired before the store lock (store.lock),
// never the reverse. The operation lock gives one mutating command exclusive
// ownership per installation and is held for its whole duration, including
// backups and patch preparation. The store lock guards only the
// load → mutate → persist critical section of the state manifest and must
// never be held during backups, patch preparation, downloads, or binary
// replacement. Neither lock is removed automatically while contended; a stale
// lock must be resolved explicitly by the operator.
const (
	operationLockName = "limit-operation.lock"
	storeLockName     = "store.lock"
	storeLockWait     = 5 * time.Second
)

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
	path := filepath.Join(directory, storeLockName)
	deadline := time.Now().Add(storeLockWait)
	for {
		lock, err := createLock(path, map[string]any{"pid": os.Getpid(), "at": time.Now().UTC().Format(time.RFC3339)})
		if err == nil {
			return lock, nil
		}
		if !errors.Is(err, os.ErrExist) && !errors.Is(err, os.ErrPermission) {
			return nil, err
		}
		if !time.Now().Before(deadline) {
			return nil, fmt.Errorf("the state store lock %s is held by another limit operation; no records were written — retry once the other limit command finishes", path)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

type operation struct {
	id   string
	lock *fileLock
}

func newOperationID() string {
	buffer := make([]byte, 8)
	_, _ = rand.Read(buffer)
	return hex.EncodeToString(buffer)
}

func (s store) beginOperation(command, id string) (*operation, error) {
	if err := os.MkdirAll(s.directory, 0700); err != nil {
		return nil, err
	}
	if id == "" {
		id = newOperationID()
	}
	path := filepath.Join(s.directory, operationLockName)
	owner := map[string]any{"id": id, "pid": os.Getpid(), "command": command, "at": time.Now().UTC().Format(time.RFC3339)}
	deadline := time.Now().Add(250 * time.Millisecond)
	for {
		lock, err := createLock(path, owner)
		if err == nil {
			return &operation{id: id, lock: lock}, nil
		}
		if errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("another limit operation owns %s; no changes were made — wait for it to finish and retry; if no limit command is running the lock is stale and must be resolved explicitly", path)
		}
		if !errors.Is(err, os.ErrPermission) || !time.Now().Before(deadline) {
			return nil, err
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (o *operation) release() error {
	if o == nil || o.lock == nil {
		return nil
	}
	return o.lock.release()
}
