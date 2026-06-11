package config

import (
	"bufio"
	"os"
	"strings"
)

// LoadEnvFile parses a KEY=value file (UTF-8, optional BOM, # comments,
// blank lines OK) and returns the resulting map merged onto the host's
// own os.Environ().
//
// The defensive BOM strip is critical: the v1 PowerShell installer's
// Out-File -Encoding UTF8 prepended an UTF-8 BOM (U+FEFF), which made
// the first key parse as "<BOM>NETMANAGER_URL" — invisible to a casual
// eye but fatal to lookup. The new installer (PR #75) writes BOM-less
// files, but existing agents on disk may still carry a BOM, so we strip
// defensively forever.
//
// Caller errors (file missing, permission denied) are intentionally
// silent — they degrade gracefully to "no overrides", which matches
// the agent's own behavior. The Validate step at install time is
// expected to catch genuine misconfiguration.
func LoadEnvFile(path string) map[string]string {
	out := envSliceToMap(os.Environ())
	if path == "" {
		return out
	}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	first := true
	for sc.Scan() {
		line := sc.Text()
		if first {
			line = strings.TrimPrefix(line, "\ufeff")
			first = false
		}
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		// Defensive: strip BOM if it survived past the first-line strip
		// (e.g. file was concatenated from multiple BOM-prefixed sources).
		k = strings.TrimPrefix(k, "\ufeff")
		if k == "" {
			continue
		}
		out[k] = v
	}
	return out
}

func envSliceToMap(env []string) map[string]string {
	m := make(map[string]string, len(env))
	for _, e := range env {
		if k, v, ok := strings.Cut(e, "="); ok {
			m[k] = v
		}
	}
	return m
}
