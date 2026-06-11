//go:build !windows

package service

import (
	"errors"
	"path/filepath"

	"github.com/Coosef/netmanager/charon-agent-host/internal/config"
	"github.com/Coosef/netmanager/charon-agent-host/internal/logging"
)

// Non-Windows stub so the rest of the codebase compiles. None of the
// CLI subcommands except `version` and unit-tested pure logic run on
// non-Windows targets.
type Handler struct {
	Cfg config.Config
	Log *logging.Logger
	Evt *logging.EventLog
}

// ErrUnsupportedPlatform is returned by service-related operations on
// non-Windows builds.
var ErrUnsupportedPlatform = errors.New("service operations only supported on Windows")

func ResolveLogDir(cfg config.Config) string {
	return filepath.Clean(cfg.LogDir)
}
