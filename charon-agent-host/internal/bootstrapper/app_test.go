package bootstrapper

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/install"
	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/platform"
	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/runtime"
)

// fakeProbes returns a Probes value backed by canned results so the
// planner runs hermetically on any OS.
func fakeProbes(
	archSnap platform.ArchitectureSnapshot,
	osVer platform.OSVersion,
	priv platform.Privilege,
	reboot platform.RebootStatus,
	installDisk platform.DiskInfo,
	dataDisk platform.DiskInfo,
) Probes {
	return Probes{
		DetectArchitecture: func() (platform.ArchitectureSnapshot, error) { return archSnap, nil },
		DetectOSVersion:    func() (platform.OSVersion, error) { return osVer, nil },
		DetectPrivilege:    func() (platform.Privilege, error) { return priv, nil },
		DetectReboot:       func() (platform.RebootStatus, error) { return reboot, nil },
		DetectDiskInstall:  func(path string, min uint64) (platform.DiskInfo, error) { return installDisk, nil },
		DetectDiskData:     func(path string, min uint64) (platform.DiskInfo, error) { return dataDisk, nil },
		Resolver:           runtime.StaticResolver{},
		BootstrapperVer:    "v0.0.0-test",
	}
}

func happyPathServer2019Amd64() (Probes, *Options) {
	archSnap := platform.ArchitectureSnapshot{Native: platform.ArchAmd64, Process: platform.ArchAmd64}
	osVer := platform.OSVersion{Major: 10, Build: 17763, IsServer: true, ProductName: "Windows Server 2019"}
	priv := platform.Privilege{IsAdmin: true}
	rb := platform.RebootStatus{}
	disk := platform.DiskInfo{Path: "C:\\", FreeBytes: 100 * 1024 * 1024 * 1024, TotalBytes: 1024 * 1024 * 1024 * 1024,
		MinRequiredBytes: platform.MinimumInstallBytes, Sufficient: true}
	probes := fakeProbes(archSnap, osVer, priv, rb, disk, disk)
	opts := &Options{Mode: install.ModeOffline, BackendURL: ""}
	return probes, opts
}

func TestBuildPlan_HappyPathServer2019Amd64(t *testing.T) {
	probes, opts := happyPathServer2019Amd64()
	plan, code := BuildPlan(opts, probes)
	if code != ExitOK {
		t.Errorf("exit code = %d, want %d (blockers=%v)", code, ExitOK, plan.Blockers)
	}
	if plan.SupportStatus != platform.StatusSupported {
		t.Errorf("support_status = %q", plan.SupportStatus)
	}
	if plan.Platform != "windows-amd64" {
		t.Errorf("platform = %q", plan.Platform)
	}
	if len(plan.Blockers) != 0 {
		t.Errorf("unexpected blockers: %v", plan.Blockers)
	}
	if len(plan.RequiredArtifacts) == 0 {
		t.Error("required_artifacts must be non-empty")
	}
}

func TestBuildPlan_UnsupportedOS_ExitCode3(t *testing.T) {
	// Server 2016 -- explicitly UNSUPPORTED.
	archSnap := platform.ArchitectureSnapshot{Native: platform.ArchAmd64, Process: platform.ArchAmd64}
	osVer := platform.OSVersion{Major: 10, Build: 14393, IsServer: true, ProductName: "Windows Server 2016"}
	priv := platform.Privilege{IsAdmin: true}
	disk := platform.DiskInfo{Sufficient: true}
	probes := fakeProbes(archSnap, osVer, priv, platform.RebootStatus{}, disk, disk)
	opts := &Options{Mode: install.ModeOffline}
	plan, code := BuildPlan(opts, probes)
	if code != ExitUnsupportedOperatingSystem {
		t.Errorf("exit code = %d, want %d", code, ExitUnsupportedOperatingSystem)
	}
	if !plan.HasBlockers() {
		t.Error("UNSUPPORTED OS must surface a blocker")
	}
}

func TestBuildPlan_NotAdmin_ExitCode5(t *testing.T) {
	archSnap := platform.ArchitectureSnapshot{Native: platform.ArchAmd64, Process: platform.ArchAmd64}
	osVer := platform.OSVersion{Major: 10, Build: 17763, IsServer: true, ProductName: "Windows Server 2019"}
	priv := platform.Privilege{IsAdmin: false}
	disk := platform.DiskInfo{Sufficient: true}
	probes := fakeProbes(archSnap, osVer, priv, platform.RebootStatus{}, disk, disk)
	opts := &Options{Mode: install.ModeOffline}
	_, code := BuildPlan(opts, probes)
	if code != ExitAdministratorPrivilegesRequired {
		t.Errorf("exit code = %d, want %d", code, ExitAdministratorPrivilegesRequired)
	}
}

func TestBuildPlan_UnknownArchitecture_ExitCode4(t *testing.T) {
	archSnap := platform.ArchitectureSnapshot{Native: platform.ArchUnknown, Process: platform.ArchUnknown}
	osVer := platform.OSVersion{Major: 10, Build: 17763, IsServer: true, ProductName: "Windows Server 2019"}
	priv := platform.Privilege{IsAdmin: true}
	disk := platform.DiskInfo{Sufficient: true}
	probes := fakeProbes(archSnap, osVer, priv, platform.RebootStatus{}, disk, disk)
	opts := &Options{Mode: install.ModeOffline}
	_, code := BuildPlan(opts, probes)
	if code != ExitUnsupportedArchitecture {
		t.Errorf("exit code = %d, want %d", code, ExitUnsupportedArchitecture)
	}
}

func TestBuildPlan_InsufficientDisk_ExitCode6(t *testing.T) {
	archSnap := platform.ArchitectureSnapshot{Native: platform.ArchAmd64, Process: platform.ArchAmd64}
	osVer := platform.OSVersion{Major: 10, Build: 17763, IsServer: true, ProductName: "Windows Server 2019"}
	priv := platform.Privilege{IsAdmin: true}
	smallDisk := platform.DiskInfo{Path: "C:\\", FreeBytes: 10, MinRequiredBytes: platform.MinimumInstallBytes, Sufficient: false}
	probes := fakeProbes(archSnap, osVer, priv, platform.RebootStatus{}, smallDisk, smallDisk)
	opts := &Options{Mode: install.ModeOffline}
	plan, code := BuildPlan(opts, probes)
	if code != ExitInsufficientDiskSpace {
		t.Errorf("exit code = %d, want %d", code, ExitInsufficientDiskSpace)
	}
	if !plan.HasBlockers() {
		t.Error("insufficient disk must surface a blocker")
	}
}

func TestBuildPlan_PendingRebootWarning_NotBlocker(t *testing.T) {
	archSnap := platform.ArchitectureSnapshot{Native: platform.ArchAmd64, Process: platform.ArchAmd64}
	osVer := platform.OSVersion{Major: 10, Build: 17763, IsServer: true, ProductName: "Windows Server 2019"}
	priv := platform.Privilege{IsAdmin: true}
	disk := platform.DiskInfo{Sufficient: true}
	rb := platform.RebootStatus{CBSRebootPending: true}
	probes := fakeProbes(archSnap, osVer, priv, rb, disk, disk)
	opts := &Options{Mode: install.ModeOffline}
	plan, code := BuildPlan(opts, probes)
	if code != ExitOK {
		t.Errorf("MVP policy: pending reboot is warning, not blocker; got code %d", code)
	}
	if len(plan.Warnings) == 0 {
		t.Error("pending reboot must surface a warning")
	}
}

func TestBuildPlan_TestReadyServer2025_AddsWarning(t *testing.T) {
	archSnap := platform.ArchitectureSnapshot{Native: platform.ArchAmd64, Process: platform.ArchAmd64}
	osVer := platform.OSVersion{Major: 10, Build: 26100, IsServer: true, ProductName: "Windows Server 2025"}
	priv := platform.Privilege{IsAdmin: true}
	disk := platform.DiskInfo{Sufficient: true}
	probes := fakeProbes(archSnap, osVer, priv, platform.RebootStatus{}, disk, disk)
	opts := &Options{Mode: install.ModeOffline}
	plan, code := BuildPlan(opts, probes)
	if code != ExitOK {
		t.Errorf("TEST_READY must allow proceed; got code %d", code)
	}
	if plan.SupportStatus != platform.StatusTestReady {
		t.Errorf("support_status = %q", plan.SupportStatus)
	}
	hasWarning := false
	for _, w := range plan.Warnings {
		if strings.Contains(w, "TEST_READY") {
			hasWarning = true
			break
		}
	}
	if !hasWarning {
		t.Errorf("TEST_READY must surface a warning; got %v", plan.Warnings)
	}
}

func TestBuildPlan_JSON_NoSecretFields(t *testing.T) {
	probes, opts := happyPathServer2019Amd64()
	plan, _ := BuildPlan(opts, probes)
	b, err := plan.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !json.Valid(b[:len(b)-1]) {
		t.Error("plan JSON is not valid")
	}
	for _, banned := range []string{"agent_key", "password", "token", "jwt", "x_agent_key", "secret"} {
		if bytes.Contains(b, []byte(banned)) {
			t.Errorf("plan JSON contains banned token %q", banned)
		}
	}
}

func TestRun_ShowVersionEmitsString(t *testing.T) {
	var out, errOut bytes.Buffer
	code := Run([]string{"--version"}, &out, &errOut, "v1.2.3-pr-b")
	if code != ExitOK {
		t.Errorf("Run(--version) exit code = %d, want 0", code)
	}
	if !strings.Contains(out.String(), "v1.2.3-pr-b") {
		t.Errorf("stdout missing version: %q", out.String())
	}
}

func TestRun_InvalidArgumentMapsToExitCode2(t *testing.T) {
	var out, errOut bytes.Buffer
	code := Run([]string{"--mode=nope"}, &out, &errOut, "v")
	if code != ExitInvalidArguments {
		t.Errorf("invalid mode exit code = %d, want %d", code, ExitInvalidArguments)
	}
}

func TestRun_AgentKeyOnArgvMapsToExitCode2(t *testing.T) {
	var out, errOut bytes.Buffer
	code := Run([]string{"--agent-key=nope"}, &out, &errOut, "v")
	if code != ExitInvalidArguments {
		t.Errorf("agent-key arg exit code = %d, want %d", code, ExitInvalidArguments)
	}
}
