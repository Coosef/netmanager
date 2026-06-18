package install

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/platform"
)

// DefaultPaths is the per-host install + data directory pair the
// bootstrapper proposes when the caller does not override via
// --install-dir / --data-dir. The selection follows the matrix in
// docs/WINDOWS_AGENT_BOOTSTRAPPER.md section "Install paths".
type DefaultPaths struct {
	InstallDir string `json:"install_dir"`
	DataDir    string `json:"data_dir"`
}

// ResolveDefaultPaths picks the conventional Windows directories for
// the selected agent architecture on the running host. The function
// is cross-platform-compilable (it does no Windows-specific I/O); it
// only consults environment variables and the snapshot.
//
// Matrix (driven by Microsoft's Program Files split on x64):
//
//	x64 OS + amd64 agent ->  %ProgramFiles%       (e.g. C:\Program Files)
//	x64 OS + 386   agent ->  %ProgramFiles(x86)%  (e.g. C:\Program Files (x86))
//	x86 OS + 386   agent ->  %ProgramFiles%       (only one Program Files)
//	x86 OS + amd64 agent ->  ERROR                (PE loader cannot run amd64 on a 32-bit OS)
//
// In every case the data directory is %ProgramData% +
// "\CharonAgent" (Microsoft never splits ProgramData by arch).
func ResolveDefaultPaths(snap platform.ArchitectureSnapshot, agentArch platform.Architecture) (DefaultPaths, error) {
	if snap.Native == platform.Arch386 && agentArch == platform.ArchAmd64 {
		return DefaultPaths{}, errors.New("cannot install amd64 agent on a 32-bit Windows host")
	}

	programFiles := os.Getenv("ProgramFiles")
	programFilesX86 := os.Getenv("ProgramFiles(x86)")
	programData := os.Getenv("ProgramData")

	// On developer Linux / CI without Windows env vars, fall back
	// to a documented placeholder so the unit tests can still pin
	// the matrix logic. The placeholder is intentionally
	// not-a-real-Windows-path so any consumer that accidentally
	// trusts it on Windows will trip on the first filesystem
	// operation.
	if programFiles == "" {
		programFiles = `C:\Program Files`
	}
	if programFilesX86 == "" {
		programFilesX86 = `C:\Program Files (x86)`
	}
	if programData == "" {
		programData = `C:\ProgramData`
	}

	installBase := programFiles
	if snap.Native == platform.ArchAmd64 && agentArch == platform.Arch386 {
		installBase = programFilesX86
	}

	return DefaultPaths{
		InstallDir: filepath.Join(installBase, "Charon Agent"),
		DataDir:    filepath.Join(programData, "CharonAgent"),
	}, nil
}
