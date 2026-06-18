package install

import (
	"bytes"
	"testing"

	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/platform"
)

func TestPlanSchemaVersion_IsOne(t *testing.T) {
	if PlanSchemaVersion != 1 {
		t.Errorf("PlanSchemaVersion bumped without test update: %d", PlanSchemaVersion)
	}
}

func TestPlan_Marshal_Deterministic(t *testing.T) {
	plan := InstallationPlan{
		SchemaVersion:             PlanSchemaVersion,
		BootstrapperVersion:       "v0.0.0-pr-b",
		RequestedMode:             ModeOnline,
		BackendURL:                "https://staging.example.com",
		ProcessArchitecture:       platform.ArchAmd64,
		NativeArchitecture:        platform.ArchAmd64,
		SelectedAgentArchitecture: platform.ArchAmd64,
		Platform:                  "windows-amd64",
		OSName:                    "Windows Server 2019",
		OSVersion:                 "Windows Server 2019 [server, 10.0.17763.6532]",
		OSBuild:                   17763,
		SupportStatus:             platform.StatusSupported,
		IsAdmin:                   true,
		InstallDir:                `C:\Program Files\Charon Agent`,
		DataDir:                   `C:\ProgramData\CharonAgent`,
		Blockers:                  []string{},
		Warnings:                  []string{},
	}
	first, err := plan.Marshal()
	if err != nil {
		t.Fatalf("Marshal #1: %v", err)
	}
	second, err := plan.Marshal()
	if err != nil {
		t.Fatalf("Marshal #2: %v", err)
	}
	if !bytes.Equal(first, second) {
		t.Errorf("plan marshal not deterministic across two calls")
	}
	if first[len(first)-1] != '\n' {
		t.Error("plan marshal must end with newline")
	}
}

func TestPlan_HasBlockers(t *testing.T) {
	clean := InstallationPlan{Blockers: []string{}}
	if clean.HasBlockers() {
		t.Error("empty blockers must not report HasBlockers")
	}
	dirty := InstallationPlan{Blockers: []string{"x"}}
	if !dirty.HasBlockers() {
		t.Error("non-empty blockers must report HasBlockers")
	}
}

func TestPlan_NoSecretFieldsInJSON(t *testing.T) {
	// Sanity-pin the rule that secret fields are NEVER on the
	// plan. A regression that adds e.g. `AgentKey string` would
	// cause the encoded JSON to mention "agent_key" / "password"
	// / "token" / "secret" / "jwt" / "x_agent_key" and trip this
	// test.
	plan := InstallationPlan{
		SchemaVersion:       PlanSchemaVersion,
		BootstrapperVersion: "v0",
		RequestedMode:       ModeOnline,
		BackendURL:          "https://x.example.com",
	}
	b, err := plan.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	for _, banned := range []string{
		`"agent_key"`, `"agentkey"`,
		`"password"`,
		`"token"`,
		`"jwt"`,
		`"x_agent_key"`, `"x-agent-key"`,
		`"secret"`,
	} {
		if bytes.Contains(b, []byte(banned)) {
			t.Errorf("plan JSON contains banned field %q", banned)
		}
	}
}

func TestParseMode_AcceptsValid(t *testing.T) {
	for _, s := range []string{"online", "offline"} {
		got, err := ParseMode(s)
		if err != nil {
			t.Fatalf("ParseMode(%q): %v", s, err)
		}
		if string(got) != s {
			t.Errorf("ParseMode(%q) = %q", s, got)
		}
	}
}

func TestParseMode_RejectsInvalid(t *testing.T) {
	for _, s := range []string{"", "ONLINE", "Online", "remote", "hybrid"} {
		if _, err := ParseMode(s); err == nil {
			t.Errorf("ParseMode(%q): expected error", s)
		}
	}
}

func TestMode_IsValid(t *testing.T) {
	if !ModeOnline.IsValid() || !ModeOffline.IsValid() {
		t.Error("Online/Offline must be valid")
	}
	if Mode("nope").IsValid() {
		t.Error("invalid mode must report not-valid")
	}
}
