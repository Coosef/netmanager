package config

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// validCfg returns a Config that should pass Validate() on the
// current host. The path values are platform-specific because
// Validate() uses filepath.IsAbs, which is OS-aware: a Windows
// path like `C:\Python` is NOT absolute when the test runs on
// Linux CI. The cross-platform tests below would falsely fail
// with the same Windows literals on a Linux runner, so the path
// shape is chosen per runtime.
func validCfg() Config {
	c := Default()
	if runtime.GOOS == "windows" {
		c.ChildExe = `C:\Python312\python.exe`
		c.WorkDir = `C:\ProgramData\NetManagerAgent`
		c.LogDir = `C:\ProgramData\NetManagerAgent\logs`
	} else {
		c.ChildExe = filepath.Join("/", "usr", "bin", "python3")
		c.WorkDir = filepath.Join("/", "var", "lib", "netmanager-agent")
		c.LogDir = filepath.Join("/", "var", "log", "netmanager-agent")
	}
	return c
}

func TestValidate_DefaultsAreInsufficient(t *testing.T) {
	if err := Default().Validate(); err == nil {
		t.Fatal("Default() without child/work/log dirs must fail validation")
	}
}

func TestValidate_HappyPath(t *testing.T) {
	if err := validCfg().Validate(); err != nil {
		t.Fatalf("validCfg() should validate, got %v", err)
	}
}

func TestValidate_ServiceNameRejectsWhitespace(t *testing.T) {
	c := validCfg()
	c.ServiceName = "Has Space"
	err := c.Validate()
	if err == nil || !strings.Contains(err.Error(), "service-name") {
		t.Fatalf("expected service-name validation error, got %v", err)
	}
}

func TestValidate_ServiceNameRejectsPathSeparators(t *testing.T) {
	for _, bad := range []string{`Net\Manager`, `Net/Manager`, `Net"Manager`, `Net'Manager`} {
		c := validCfg()
		c.ServiceName = bad
		if err := c.Validate(); err == nil {
			t.Errorf("service-name %q should be rejected", bad)
		}
	}
}

func TestValidate_RequiresAbsolutePaths(t *testing.T) {
	cases := map[string]func(*Config){
		"child-exe relative": func(c *Config) { c.ChildExe = `python.exe` },
		"work-dir relative":  func(c *Config) { c.WorkDir = `NetManagerAgent` },
		"log-dir relative":   func(c *Config) { c.LogDir = `logs` },
	}
	for name, mutate := range cases {
		c := validCfg()
		mutate(&c)
		if err := c.Validate(); err == nil {
			t.Errorf("case %q should fail validation", name)
		}
	}
}

func TestValidate_OnlyLocalSystemAccepted(t *testing.T) {
	for _, bad := range []string{"", "NetworkService", "LocalService", "DOMAIN\\user"} {
		c := validCfg()
		c.ServiceAccount = bad
		err := c.Validate()
		if err == nil {
			t.Errorf("service-account %q should be rejected in MVP-0", bad)
		} else if !strings.Contains(err.Error(), "service-account") {
			t.Errorf("expected service-account error for %q, got %v", bad, err)
		}
	}
}
