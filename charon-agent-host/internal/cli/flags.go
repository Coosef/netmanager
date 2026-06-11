package cli

import (
	"flag"
	"io"
	"strings"

	"github.com/Coosef/netmanager/charon-agent-host/internal/config"
)

// installFlagSet builds the flag.FlagSet for `install` and any other
// subcommand that needs the full config (notably `run`, since the SCM
// replays install-time flags).
//
// argsForRegistry returns the slice of flags+values that should be
// embedded in the service's ImagePath so a subsequent `run` invocation
// reproduces this configuration verbatim.
func installFlagSet(out io.Writer) (*flag.FlagSet, *config.Config, *string, *[]string) {
	cfg := config.Default()
	var childArgsStr string

	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.SetOutput(out)
	fs.StringVar(&cfg.ServiceName, "service-name", cfg.ServiceName, "Windows service identifier")
	fs.StringVar(&cfg.DisplayName, "display-name", cfg.DisplayName, "Human-readable service name")
	fs.StringVar(&cfg.Description, "description", cfg.Description, "Service description")
	fs.StringVar(&cfg.ChildExe, "child-exe", "", "Absolute path to child executable (e.g. python.exe)")
	fs.StringVar(&childArgsStr, "child-args", "", "Comma-separated args for child (typical: path to run_agent.py)")
	fs.StringVar(&cfg.WorkDir, "work-dir", "", "Absolute working directory")
	fs.StringVar(&cfg.EnvFile, "env-file", "", "Path to config.env (KEY=value lines)")
	fs.StringVar(&cfg.LogDir, "log-dir", "", "Directory for service-host.log and agent.std{out,err}.log")
	fs.StringVar(&cfg.ServiceAccount, "service-account", cfg.ServiceAccount, "Service identity (MVP-0: LocalSystem only)")

	// argsForRegistry is computed by the caller from cfg + childArgsStr
	// AFTER parsing.
	args := []string{}
	return fs, &cfg, &childArgsStr, &args
}

// splitCSV splits "a,b,c" → ["a","b","c"], handling empty input.
func splitCSV(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// buildRegistryArgs reconstructs the argv slice that, when passed to
// the host binary on a future `run` invocation, will reproduce the
// install-time configuration. This is what gets baked into the
// service's ImagePath via mgr.CreateService(..., args...).
func buildRegistryArgs(cfg config.Config, childArgs []string) []string {
	args := []string{
		"run",
		"--service-name", cfg.ServiceName,
		"--display-name", cfg.DisplayName,
		"--description", cfg.Description,
		"--child-exe", cfg.ChildExe,
		"--work-dir", cfg.WorkDir,
		"--env-file", cfg.EnvFile,
		"--log-dir", cfg.LogDir,
		"--service-account", cfg.ServiceAccount,
	}
	if len(childArgs) > 0 {
		args = append(args, "--child-args", strings.Join(childArgs, ","))
	}
	return args
}
