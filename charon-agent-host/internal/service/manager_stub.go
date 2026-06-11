//go:build !windows

package service

import (
	"errors"
	"time"

	"github.com/Coosef/netmanager/charon-agent-host/internal/config"
)

// Stubs so the CLI compiles on non-Windows. All return
// ErrUnsupportedPlatform.

var (
	ErrServiceExists   = errors.New("service: already exists")
	ErrServiceNotFound = errors.New("service: not found")
	ErrDeletePending   = errors.New("service: deleted but SCM unregistration still pending")
)

func Install(exePath string, cfg config.Config, args []string) error {
	return ErrUnsupportedPlatform
}

func Uninstall(serviceName string, deleteTimeout time.Duration) error {
	return ErrUnsupportedPlatform
}

func Start(serviceName string) error                   { return ErrUnsupportedPlatform }
func Stop(serviceName string) error                    { return ErrUnsupportedPlatform }
func Status(serviceName string) (string, error)        { return "", ErrUnsupportedPlatform }
func RunUnderSCM(serviceName string, h *Handler) error { return ErrUnsupportedPlatform }
