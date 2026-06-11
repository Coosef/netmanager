package config

// ProgramDataPath is the MVP-0 install root. Backward-compat with the
// v1 Python installer's directory layout; the Charon rename is a
// separate migration package (see docs/AGENT_V2_GO_ARCHITECTURE.md).
const ProgramDataPath = `C:\ProgramData\NetManagerAgent`

// Subdirectories under ProgramDataPath populated by the PowerShell
// installer (PR #77) before the host's first run.
const (
	BinDir     = ProgramDataPath + `\bin`
	LogDir     = ProgramDataPath + `\logs`
	ConfigFile = ProgramDataPath + `\config.env`
)
