package logging

import (
	"io"
	"log/slog"
	"os"

	"github.com/Coosef/netmanager/charon-agent-host/internal/version"
)

// Logger is a thin wrapper around slog. It centralizes the structured
// fields every log entry should carry (host_version, build) so we
// avoid copy-pasting them at every call site.
type Logger struct {
	base   *slog.Logger
	writer io.WriteCloser // owned; nil if writing to os.Stderr only
}

// NewServiceLogger builds a Logger that writes JSON lines to
// <logDir>/service-host.log via a rotating writer. When logDir is
// empty (interactive `run --console` mode), stderr is used directly.
func NewServiceLogger(logDir string) (*Logger, error) {
	var (
		writer io.WriteCloser
		out    io.Writer
	)
	if logDir == "" {
		out = os.Stderr
	} else {
		rw := NewRotatingWriter(logDir, "service-host", ".log")
		writer = rw
		out = rw
	}

	h := slog.NewJSONHandler(out, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})
	base := slog.New(h).With(
		slog.String("host_version", version.Version),
		slog.String("host_build", version.Build),
	)
	return &Logger{base: base, writer: writer}, nil
}

// Info / Warn / Error are thin pass-throughs that match slog's
// variadic key/value convention.
func (l *Logger) Info(msg string, args ...any)  { l.base.Info(msg, args...) }
func (l *Logger) Warn(msg string, args ...any)  { l.base.Warn(msg, args...) }
func (l *Logger) Error(msg string, args ...any) { l.base.Error(msg, args...) }

// Close releases the underlying file handle. Safe to call when there's
// no owned writer (console mode).
func (l *Logger) Close() error {
	if l.writer != nil {
		return l.writer.Close()
	}
	return nil
}
