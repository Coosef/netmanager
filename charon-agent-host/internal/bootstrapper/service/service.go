// Package service stubs out the Windows Service Control Manager
// integration the bootstrapper will eventually use to register the
// CharonAgent service. PR-B does NOT register or mutate any
// service; the package is here purely so the import graph and CLI
// surface area are in place for PR-C / PR-F.
package service

// Default service identifiers. The constants are stable across
// PRs so that operator-facing tooling can reference them via the
// Go module.
const (
	ServiceName = "CharonAgent"
	DisplayName = "Charon NetManager Agent"
	Description = "Self-contained NetManager Charon agent host"
	StartType   = "automatic-delayed"
	ServiceUser = "LocalSystem"
)

// Plan is the planned-but-not-applied service registration the
// bootstrapper surfaces in its JSON output. PR-C will turn this
// struct into the input of a real
// `windows/svc/mgr.Service.Create()` call.
type Plan struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
	StartType   string `json:"start_type"`
	User        string `json:"user"`
}

// DefaultPlan returns the bootstrapper's recommended service
// registration. The constants above are the single source of
// truth; this helper keeps construction in one place so the JSON
// output stays deterministic.
func DefaultPlan() Plan {
	return Plan{
		Name:        ServiceName,
		DisplayName: DisplayName,
		Description: Description,
		StartType:   StartType,
		User:        ServiceUser,
	}
}
