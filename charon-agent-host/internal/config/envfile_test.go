package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadEnvFile_BasicKeyValue(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.env")
	os.WriteFile(p, []byte("FOO=bar\nBAZ=qux\n"), 0o600)

	env := LoadEnvFile(p)
	if env["FOO"] != "bar" || env["BAZ"] != "qux" {
		t.Fatalf("env mismatch: %v", env)
	}
}

func TestLoadEnvFile_StripsLeadingBOM(t *testing.T) {
	// Mimics the v1 Out-File -Encoding UTF8 problem: BOM glued to the
	// first key.
	dir := t.TempDir()
	p := filepath.Join(dir, "config.env")
	body := []byte("\xef\xbb\xbfNETMANAGER_URL=https://x\nNETMANAGER_AGENT_ID=abc\n")
	os.WriteFile(p, body, 0o600)

	env := LoadEnvFile(p)
	if got := env["NETMANAGER_URL"]; got != "https://x" {
		t.Fatalf("BOM not stripped from first key. Got NETMANAGER_URL=%q (env keys: %v)", got, keys(env))
	}
	if _, leaked := env["\xef\xbb\xbfNETMANAGER_URL"]; leaked {
		t.Fatalf("BOM-prefixed key leaked: %v", keys(env))
	}
}

func TestLoadEnvFile_IgnoresCommentsAndBlanks(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.env")
	os.WriteFile(p, []byte("# comment line\n\nKEY=value\n"), 0o600)

	env := LoadEnvFile(p)
	if env["KEY"] != "value" {
		t.Fatalf("expected KEY=value, got %v", env)
	}
}

func TestLoadEnvFile_TrimWhitespace(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.env")
	os.WriteFile(p, []byte("  PAD =  spaced  \n"), 0o600)

	env := LoadEnvFile(p)
	if env["PAD"] != "spaced" {
		t.Fatalf("expected trimmed value, got %q", env["PAD"])
	}
}

func TestLoadEnvFile_MissingPathReturnsEnviron(t *testing.T) {
	env := LoadEnvFile("/path/that/does/not/exist.env")
	// Should at least contain something from the test process env.
	if len(env) == 0 {
		t.Fatal("missing file should fall back to os.Environ, got empty map")
	}
}

func TestLoadEnvFile_OverridesProcessEnv(t *testing.T) {
	t.Setenv("CHARON_TEST_OVERRIDE", "from-process")
	dir := t.TempDir()
	p := filepath.Join(dir, "config.env")
	os.WriteFile(p, []byte("CHARON_TEST_OVERRIDE=from-file\n"), 0o600)

	env := LoadEnvFile(p)
	if env["CHARON_TEST_OVERRIDE"] != "from-file" {
		t.Fatalf("file should override env, got %q", env["CHARON_TEST_OVERRIDE"])
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
