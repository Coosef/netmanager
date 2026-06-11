package cli

import (
	"flag"
	"io"
	"strings"

	"github.com/Coosef/netmanager/charon-agent-host/internal/config"
)

// stringSliceFlag is a flag.Value implementation that accumulates
// repeated occurrences of the same flag into a string slice. The
// previous --child-args CSV approach broke as soon as any single
// argument contained a comma — and Python / PowerShell scripts
// embedded as `-Command` payloads typically do (e.g. the integration
// test's `WriteAllText($pidFile, $PID.ToString())`). Repeating the
// flag avoids any in-band delimiter ambiguity entirely.
type stringSliceFlag []string

func (s *stringSliceFlag) String() string {
	if s == nil {
		return ""
	}
	return strings.Join(*s, " ")
}

func (s *stringSliceFlag) Set(v string) error {
	*s = append(*s, v)
	return nil
}

// installFlagSet builds the flag.FlagSet for `install` and any other
// subcommand that needs the full config (notably `run`, since the SCM
// replays install-time flags).
//
// The returned `childArgs` is populated as the flag set parses
// repeated `--child-arg` occurrences; the caller copies it into
// cfg.ChildArgs after parsing.
func installFlagSet(out io.Writer) (*flag.FlagSet, *config.Config, *stringSliceFlag) {
	cfg := config.Default()
	var childArgs stringSliceFlag

	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.SetOutput(out)
	fs.StringVar(&cfg.ServiceName, "service-name", cfg.ServiceName, "Windows service identifier")
	fs.StringVar(&cfg.DisplayName, "display-name", cfg.DisplayName, "Human-readable service name")
	fs.StringVar(&cfg.Description, "description", cfg.Description, "Service description")
	fs.StringVar(&cfg.ChildExe, "child-exe", "", "Absolute path to child executable (e.g. python.exe)")
	fs.Var(&childArgs, "child-arg", "Single child argument (repeat for multiple)")
	fs.StringVar(&cfg.WorkDir, "work-dir", "", "Absolute working directory")
	fs.StringVar(&cfg.EnvFile, "env-file", "", "Path to config.env (KEY=value lines)")
	fs.StringVar(&cfg.LogDir, "log-dir", "", "Directory for service-host.log and agent.std{out,err}.log")
	fs.StringVar(&cfg.ServiceAccount, "service-account", cfg.ServiceAccount, "Service identity (MVP-0: LocalSystem only)")

	return fs, &cfg, &childArgs
}

// buildRegistryArgs reconstructs the argv slice that, when passed to
// the host binary on a future `run` invocation, will reproduce the
// install-time configuration. This is what gets baked into the
// service's ImagePath via mgr.CreateService(..., args...).
//
// child arguments are emitted as one `--child-arg <value>` pair per
// element so values containing commas, spaces, quotes, etc. survive
// round-trip through the SCM's ImagePath without parsing damage.
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
	for _, a := range childArgs {
		args = append(args, "--child-arg", a)
	}
	return args
}
