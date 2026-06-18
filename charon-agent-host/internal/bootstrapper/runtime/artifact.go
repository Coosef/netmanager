// Package runtime defines the resolver interface the bootstrapper
// uses to plan which artifacts must be present before the install
// proceeds. PR-B ships only the interface + a static resolver; PR-C
// wires the real online + offline resolvers.
package runtime

import (
	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/install"
	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/platform"
)

// PlanResolver decides which logical artifacts a plan needs given
// the (mode, target-architecture) tuple. The bootstrapper is
// Windows-only at runtime, so the OS family axis is implicit. The
// resolver returns ArtifactRequirement entries with the Platform
// field already populated as "windows-<arch>".
//
// Implementations:
//
//   - StaticResolver: hardcoded list (PR-B; used by the skeleton).
//   - OnlineResolver: backend-driven (PR-C).
//   - OfflineResolver: bundle-inspector (PR-F).
type PlanResolver interface {
	Resolve(mode install.Mode, arch platform.Architecture) []install.ArtifactRequirement
}
