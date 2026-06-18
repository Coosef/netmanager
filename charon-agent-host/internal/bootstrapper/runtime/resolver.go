package runtime

import (
	"fmt"

	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/install"
	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/platform"
)

// StaticResolver returns the same hardcoded requirement list for
// every (mode, arch) combination -- exactly the artifacts the MVP
// installer expects to fetch (online) or have bundled (offline).
//
// The list is identical in offline + online modes; the difference
// at install time is the source, not the inventory.
type StaticResolver struct{}

// Resolve implements PlanResolver. The Platform string is formed
// here so that downstream JSON consumers can match the artifact
// against the PR-A canonical platform names directly.
func (StaticResolver) Resolve(mode install.Mode, arch platform.Architecture) []install.ArtifactRequirement {
	plat := fmt.Sprintf("windows-%s", arch)
	return []install.ArtifactRequirement{
		{Kind: install.ArtifactManifest, Platform: plat, Required: true},
		{Kind: install.ArtifactChecksums, Platform: plat, Required: true},
		{Kind: install.ArtifactSignature, Platform: plat, Required: true},
		{Kind: install.ArtifactRuntime, Platform: plat, Required: true},
		{Kind: install.ArtifactHost, Platform: plat, Required: true},
		{Kind: install.ArtifactUpdater, Platform: plat, Required: true},
		{Kind: install.ArtifactLicenses, Platform: plat, Required: true},
	}
}
