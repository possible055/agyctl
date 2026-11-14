package limit

import (
	"agyctl/internal/patchlock"
)

// The operation lock (limit-operation.lock) is acquired before the state
// store lock, never the reverse. Both names and their lifecycle live in the
// patchlock package so the tool-output feature serializes against limit on
// the same locks instead of opening competing files.
type operation struct{ *patchlock.Operation }

func (s store) beginOperation(command, id string) (*operation, error) {
	op, err := patchlock.BeginOperation(s.directory, command, id)
	if err != nil {
		return nil, err
	}
	return &operation{Operation: op}, nil
}

func (o *operation) release() error { return o.Release() }

func (o *operation) identifier() string { return o.ID() }
