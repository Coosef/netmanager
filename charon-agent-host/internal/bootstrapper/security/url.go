package security

import (
	"errors"
	"net/url"
	"strings"
)

// ValidateBackendURL enforces the constraints PR #89 enforces on the
// Python side
// (`backend/app/api/v1/endpoints/agents.py::_normalize_windows_installer_base_url`)
// plus PR-B security hardening:
//
//   - non-empty
//   - scheme is http or https
//   - host (netloc) present
//   - **NO userinfo** (username / password / "user@host" / "user:pass@host" /
//     percent-encoded variants -- credentials in URLs leak through proxy
//     logs and history; the bootstrapper refuses them outright)
//   - **NO fragment** (`#frag`); a base backend URL has no use for a
//     client-side fragment
//   - **NO query string** (`?q=...`); base URL is for path concat only
//   - no shell-meta or quote characters (defence-in-depth against
//     interpolation into PowerShell single-quoted literals later
//     in the chain)
//   - trailing slashes stripped (matches the Run T1.02 fix that
//     prevented "//api/v1/..." double-slash URLs)
//
// Returns the normalised URL on success. Returns the empty string +
// a generic error on rejection -- the caller MUST NOT use the input
// URL on error. The error text NEVER includes the offending input
// value, so an accidentally-pasted password-bearing URL does not
// leak through the error path.
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
		// Generic message; do NOT echo the raw URL (it may carry
		// credentials the operator did not realise were captured).
		return "", errors.New("backend URL could not be parsed")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("backend URL must use http or https scheme")
	}
	if u.Host == "" {
		return "", errors.New("backend URL is missing host")
	}
	// PR-B hardening: reject credentials embedded in the URL. The
	// error message intentionally does NOT include the URL or its
	// userinfo component so a paste of a password-bearing URL on the
	// CLI does not echo through stderr / log / plan output.
	if u.User != nil {
		return "", errors.New("backend URL must not embed credentials (user@host or user:pass@host)")
	}
	if u.Fragment != "" {
		return "", errors.New("backend URL must not include a fragment")
	}
	if u.RawQuery != "" {
		return "", errors.New("backend URL must not include a query string")
	}
	return s, nil
}
