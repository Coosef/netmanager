package install

import (
	"encoding/json"

	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/platform"
)

// PlanSchemaVersion pins the JSON schema for InstallationPlan. The
// version-bumping discipline is: any field rename / removal / type
// change requires bumping the version; pure additions to optional
// fields do not. Consumers MUST refuse to parse a plan whose
// schema_version exceeds the highest they understand.
const PlanSchemaVersion = 1

// ArtifactKind enumerates the logical artifact categories the
// bootstrapper's manifest will resolve. Concrete URLs are NOT
// populated in PR-B; this is a planning-only structure.
type ArtifactKind string

const (
	ArtifactHost      ArtifactKind = "host"
	ArtifactUpdater   ArtifactKind = "updater"
	ArtifactRuntime   ArtifactKind = "private_runtime"
	ArtifactManifest  ArtifactKind = "manifest"
	ArtifactChecksums ArtifactKind = "checksums"
	ArtifactSignature ArtifactKind = "signature"
	ArtifactLicenses  ArtifactKind = "licenses"
)

// ArtifactRequirement is one logical artifact the bootstrapper
// expects to fetch / unpack. PR-B emits the *list* of requirements;
// PR-C wires concrete download URLs and SHA checks.
type ArtifactRequirement struct {
	Kind     ArtifactKind `json:"kind"`
	Platform string       `json:"platform"`
	// Required is true for every artifact in the MVP; the field is
	// here so that a future "optional license bundle" can opt out
	// without breaking the schema.
	Required bool `json:"required"`
}

// InstallationPlan is the immutable, deterministic JSON-serialisable
// summary the bootstrapper emits. Fields are ordered alphabetically
// by JSON tag so that two plans produced from the same input are
// byte-identical (load-bearing for unit tests + reproducible
// operator workflows).
//
// Secret values (agent_key, JWT, password, token) MUST NEVER appear
// in this struct. The CLI gate enforces that policy too.
type InstallationPlan struct {
	BackendURL                string                 `json:"backend_url,omitempty"`
	Blockers                  []string               `json:"blockers"`
	BootstrapperVersion       string                 `json:"bootstrapper_version"`
	DataDir                   string                 `json:"data_dir"`
	Disk                      []platform.DiskInfo    `json:"disk,omitempty"`
	DryRun                    bool                   `json:"dry_run"`
	InstallDir                string                 `json:"install_dir"`
	IsAdmin                   bool                   `json:"is_admin"`
	IsLocalSystem             bool                   `json:"is_local_system"`
	NativeArchitecture        platform.Architecture  `json:"native_architecture"`
	NonInteractive            bool                   `json:"non_interactive"`
	OSBuild                   uint32                 `json:"os_build"`
	OSName                    string                 `json:"os_name"`
	OSVersion                 string                 `json:"os_version"`
	PendingReboot             platform.RebootStatus  `json:"pending_reboot"`
	Platform                  string                 `json:"platform"`
	ProcessArchitecture       platform.Architecture  `json:"process_architecture"`
	RequestedMode             Mode                   `json:"requested_mode"`
	RequiredArtifacts         []ArtifactRequirement  `json:"required_artifacts"`
	SchemaVersion             int                    `json:"schema_version"`
	SelectedAgentArchitecture platform.Architecture  `json:"selected_agent_architecture"`
	SupportStatus             platform.SupportStatus `json:"support_status"`
	Warnings                  []string               `json:"warnings"`
	WOW64                     bool                   `json:"wow64"`
}

// Marshal returns the canonical JSON encoding of the plan with 2-
// space indent and a trailing newline. Two plans whose JSON marshal
// outputs differ are by definition different plans -- this is the
// equality contract.
func (p InstallationPlan) Marshal() ([]byte, error) {
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// HasBlockers reports whether the plan carries any blocker. The CLI
// layer treats a non-empty blocker list as a refusal to proceed
// even when --dry-run is set; the exit code surfaces the specific
// blocker class via the exitcodes package.
func (p InstallationPlan) HasBlockers() bool {
	return len(p.Blockers) > 0
}
