package limit

import (
	"agyctl/internal/apptarget"
	"agyctl/internal/layout"
	"agyctl/internal/winproc"
)

func channelOf(binary string) string { return apptarget.ChannelOf(binary) }

func readVersion(binary string) (string, string, error) { return apptarget.ReadVersion(binary) }

func targetForBinary(binary string, candidates []layout.Target) (winproc.Target, error) {
	return apptarget.TargetForBinary(binary, candidates)
}

func appRunning(binary string, candidates []layout.Target) (*bool, error) {
	return apptarget.AppRunning(binary, candidates)
}

func requireStopped(running *bool, probeErr error) error {
	return apptarget.RequireStopped(running, probeErr)
}
