package platform

// Privilege describes whether the running process has the rights
// the installer needs (effectively: elevated Administrator on
// Windows). The bootstrapper does NOT self-elevate in PR-B;
// self-elevation is a PR-C / PR-F concern. The current behaviour
// when IsAdmin == false is to surface a structured blocker and
// exit with EBootstrapperPrivilegeRequired.
type Privilege struct {
	IsAdmin bool `json:"is_admin"`
	// IsLocalSystem is true when the running process is
	// LocalSystem itself (i.e. the bootstrapper was invoked via
	// the Service Control Manager rather than from an interactive
	// session). Useful for distinguishing "run by an admin
	// operator" from "run as part of a deployment pipeline".
	IsLocalSystem bool `json:"is_local_system"`
}
