package winproc

import (
	"fmt"
	"strconv"
	"strings"
)

func pgrepResult(output []byte, code int) (bool, error) {
	pids := strings.Fields(string(output))
	if code == 1 && len(pids) == 0 {
		return false, nil
	}
	if code != 0 {
		return false, fmt.Errorf("process inventory failed (pgrep exit %d)", code)
	}
	if len(pids) == 0 {
		return false, fmt.Errorf("process inventory returned no process IDs with success")
	}
	for _, pid := range pids {
		value, err := strconv.ParseUint(pid, 10, 32)
		if err != nil || value == 0 {
			return false, fmt.Errorf("process inventory returned an invalid process ID")
		}
	}
	return true, nil
}
