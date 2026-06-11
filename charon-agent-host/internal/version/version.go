// Package version exposes build-time injected version metadata.
//
// Values are set via -ldflags '-X' at build time (see Makefile).
package version

var (
	// Version is the semantic version of this build (e.g. "v2.0.0-mvp0").
	Version = "dev"

	// Build is the short git commit SHA the binary was built from.
	Build = "unknown"

	// BuildDate is the UTC timestamp of the build (RFC3339).
	BuildDate = "unknown"
)

// String returns a human-readable single-line version string suitable
// for the `version` CLI subcommand and Event Log entries.
func String() string {
	return "charon-agent-host " + Version + " (build " + Build + ", " + BuildDate + ")"
}
