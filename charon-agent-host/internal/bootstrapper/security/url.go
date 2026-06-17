package security

import (
	"errors"
	"net/url"
	"strings"
)

// ValidateBackendURL enforces the same constraints PR #89 enforces
// on the Python side
// (`backend/app/api/v1/endpoints/agents.py::_normalize_windows_installer_base_url`):
//
//   - non-empty
//   - scheme is http or https
//   - host (netloc) present
//   - no shell-meta or quote characters (defence-in-depth against
//     interpolation into PowerShell single-quoted literals later
//     in the chain)
//   - trailing slashes stripped (matches the Run T1.02 fix that
//     prevented "//api/v1/..." double-slash URLs)
//
// Returns the normalised URL (trailing-slash-stripped) on success.
// Returns the empty string and a non-nil error on rejection -- the
// caller MUST NOT use the input URL on error.
func ValidateBackendURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", errors.New("backend URL is empty")
	}

	const forbidden = "\"';|`$&\\<> "
	for _, r := range s {
		if r == '\n' || r == '\r' {
			return "", errors.New("backend URL contains newline character")
		}
		if r < 0x20 || r == 0x7F {
			return "", errors.New("backend URL contains control character")
		}
		if strings.ContainsRune(forbidden, r) {
			return "", errors.New("backend URL contains forbidden character (\\\";'|`$&\\\\<> space)")
		}
	}

	s = strings.TrimRight(s, "/")
	if s == "" {
		return "", errors.New("backend URL is only slashes")
	}

	u, err := url.Parse(s)
	if err != nil {
		return "", errors.New("backend URL could not be parsed")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("backend URL must use http or https scheme")
	}
	if u.Host == "" {
		return "", errors.New("backend URL is missing host")
	}
	return s, nil
}
