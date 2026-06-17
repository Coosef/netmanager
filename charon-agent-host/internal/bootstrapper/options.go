package bootstrapper

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/install"
	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/platform"
	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/security"
)

// Options is the parsed-and-validated CLI input. The struct holds
// no secrets -- the bootstrapper REFUSES to accept agent_key /
// password / token / JWT on the command line by design (see
// docs/WINDOWS_AGENT_BOOTSTRAPPER.md "Secrets handling").
type Options struct {
	Mode           install.Mode
	BackendURL     string
	AgentID        string
	ConfigPath     string
	InstallDir     string
	DataDir        string
	OutputFormat   string
	DryRun         bool
	NonInteractive bool
	ShowVersion    bool
	ShowHelp       bool
	ForceArch      platform.Architecture
}

// ForbiddenFlagNames is the explicit deny-list of CLI argument
// names that, if seen on argv, cause the parser to refuse rather
// than silently ignore. The list keeps a future caller honest:
// even an accidentally-pasted `--agent-key=...` is caught.
var ForbiddenFlagNames = []string{
	"agent-key", "agent_key",
	"agentkey", "agent-secret",
	"password", "pass",
	"token", "jwt",
	"x-agent-key",
}

// Parse parses argv into Options. The first element of args must
// NOT be argv[0] -- callers pass os.Args[1:] (matching the
// internal/cli convention used by the existing host CLI).
//
// errOut is used for diagnostic prints when the parser rejects an
// argument set; the parser itself returns the structured error so
// the caller can map it to an exit code.
func Parse(args []string, errOut io.Writer) (*Options, error) {
	// First pass: reject any forbidden flag name before the flag
	// package has a chance to consume the value (and potentially
	// log it). We check both `--name=value` and `--name value`
	// shapes.
	for _, a := range args {
		stripped := strings.TrimLeft(a, "-")
		head := stripped
		if eq := strings.IndexByte(stripped, '='); eq >= 0 {
			head = stripped[:eq]
		}
		head = strings.ToLower(head)
		for _, banned := range ForbiddenFlagNames {
			if head == banned {
				return nil, fmt.Errorf("CLI argument %q is forbidden (secrets MUST NOT be passed on argv)", head)
			}
		}
	}

	fs := flag.NewFlagSet("charon-agent-bootstrapper", flag.ContinueOnError)
	fs.SetOutput(errOut)
	fs.Usage = func() {
		fmt.Fprintln(errOut, "Usage: charon-agent-bootstrapper [flags]")
		fs.PrintDefaults()
	}

	var (
		mode           = fs.String("mode", string(install.ModeOnline), "online | offline")
		backend        = fs.String("backend-url", "", "central backend URL (http/https only; trailing slash normalised)")
		agentID        = fs.String("agent-id", "", "agent identifier (NOT a secret)")
		config         = fs.String("config", "", "path to bootstrapper config file")
		installDir     = fs.String("install-dir", "", "override default install directory")
		dataDir        = fs.String("data-dir", "", "override default data directory")
		output         = fs.String("output", "text", "text | json")
		dryRun         = fs.Bool("dry-run", false, "plan-only; do not mutate filesystem or service state")
		nonInteractive = fs.Bool("non-interactive", false, "never prompt; structured failure on missing input")
		forceArch      = fs.String("force-arch", "", "force agent architecture (amd64 | 386); off by default")
		showVersion    = fs.Bool("version", false, "print bootstrapper version + exit")
		showHelp       = fs.Bool("help", false, "print usage + exit")
	)
	if err := fs.Parse(args); err != nil {
		return nil, fmt.Errorf("flag parse: %w", err)
	}

	if *showVersion || *showHelp {
		return &Options{
			ShowVersion: *showVersion,
			ShowHelp:    *showHelp,
		}, nil
	}

	opts := &Options{
		AgentID:        *agentID,
		ConfigPath:     *config,
		DryRun:         *dryRun,
		NonInteractive: *nonInteractive,
		OutputFormat:   strings.ToLower(strings.TrimSpace(*output)),
	}

	parsedMode, err := install.ParseMode(*mode)
	if err != nil {
		return nil, err
	}
	opts.Mode = parsedMode

	if opts.OutputFormat != "text" && opts.OutputFormat != "json" {
		return nil, errors.New(`--output must be "text" or "json"`)
	}

	if *backend != "" {
		clean, err := security.ValidateBackendURL(*backend)
		if err != nil {
			return nil, err
		}
		opts.BackendURL = clean
	} else if opts.Mode == install.ModeOnline {
		return nil, errors.New("--backend-url is required when --mode=online")
	}

	if *installDir != "" {
		if err := security.ValidateInstallPath(*installDir); err != nil {
			return nil, err
		}
		opts.InstallDir = *installDir
	}
	if *dataDir != "" {
		if err := security.ValidateInstallPath(*dataDir); err != nil {
			return nil, err
		}
		opts.DataDir = *dataDir
	}

	if *forceArch != "" {
		fa, err := platform.ParseArchitecture(*forceArch)
		if err != nil {
			return nil, err
		}
		opts.ForceArch = fa
	}
	return opts, nil
}
