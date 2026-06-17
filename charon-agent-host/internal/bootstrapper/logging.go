package bootstrapper

import (
	"io"
	"log/slog"
)

// NewLogger returns a JSON slog.Logger writing to w, with the
// bootstrapper-version field auto-injected on every record. The
// bootstrapper deliberately does NOT reuse charon-agent-host's
// service logger because the bootstrapper is a one-shot process
// that runs without a log directory; structured stdout is enough.
//
// Sensitive fields MUST NOT be passed via the logger -- the
// design enforces this by having the surrounding code only ever
// stream public planning fields (architecture, OS version,
// install path, mode, exit code). The CLI parser rejects
// secret-bearing flag names so logged values are tame by
// construction.
func NewLogger(w io.Writer, bootstrapperVersion string) *slog.Logger {
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: slog.LevelInfo})
	return slog.New(h).With(
		slog.String("component", "charon-agent-bootstrapper"),
		slog.String("bootstrapper_version", bootstrapperVersion),
	)
}
