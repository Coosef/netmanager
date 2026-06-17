// Package security carries the bootstrapper's input-sanitisation
// helpers: path guards, URL guards, manifest stubs. None of the
// functions here perform any I/O.
package security

import (
	"errors"
	"strings"
)

// ValidateInstallPath rejects path arguments that the bootstrapper
// MUST NOT accept as install or data directories, regardless of
// who provided them (CLI argument, environment variable, embedded
// default).
//
// Rejected:
//   - empty / whitespace-only path
//   - non-absolute path (relative paths invite ambiguity about the
//     working directory at install time; we always want a fully
//     qualified Windows path)
//   - any segment containing ".." (traversal)
//   - UNC paths beginning "\\\\server\\share\\" (network shares are
//     out of scope for the MVP; PR-F may revisit)
//   - device paths beginning "\\\\?\\" or "\\\\.\\" (raw NT object
//     paths bypass Win32 semantics we depend on)
//   - any code point in 0x00..0x1F or 0x7F (control characters;
//     includes NUL)
//
// The function uses no Windows-specific syscalls; it is pure string
// inspection and runs identically on every platform.
func ValidateInstallPath(p string) error {
	trimmed := strings.TrimSpace(p)
	if trimmed == "" {
		return errors.New("install path is empty")
	}
	if trimmed != p {
		return errors.New("install path has leading or trailing whitespace")
	}
	if hasControlChar(p) {
		return errors.New("install path contains control characters")
	}
	if strings.HasPrefix(p, `\\?\`) || strings.HasPrefix(p, `\\.\`) {
		return errors.New("install path uses device-namespace prefix (\\\\?\\ or \\\\.\\) which is not allowed")
	}
	if strings.HasPrefix(p, `\\`) {
		return errors.New("install path is UNC (\\\\server\\share) which is not allowed in MVP")
	}
	if !isAbsoluteWindowsPath(p) {
		return errors.New("install path is not an absolute Windows path (expected drive letter + ':' + separator)")
	}
	for _, seg := range splitSegments(p) {
		if seg == ".." {
			return errors.New("install path contains '..' traversal segment")
		}
	}
	return nil
}

// isAbsoluteWindowsPath returns true for "C:\foo", "C:/foo", drive-
// letter + colon + separator. Lowercase drive letters are accepted.
func isAbsoluteWindowsPath(p string) bool {
	if len(p) < 3 {
		return false
	}
	c := p[0]
	if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
		return false
	}
	if p[1] != ':' {
		return false
	}
	if p[2] != '\\' && p[2] != '/' {
		return false
	}
	return true
}

// splitSegments breaks the path on both Windows + Unix separators
// since the guard runs on inputs from a CLI parser that may have
// normalised either way.
func splitSegments(p string) []string {
	fields := strings.FieldsFunc(p, func(r rune) bool {
		return r == '\\' || r == '/'
	})
	return fields
}

// hasControlChar returns true if s contains any byte in [0x00,
// 0x1F] or 0x7F. We scan bytes rather than runes because legitimate
// non-ASCII path components (e.g. Turkish "Çalışma") are allowed --
// only control bytes are illegal.
func hasControlChar(s string) bool {
	for i := 0; i < len(s); i++ {
		b := s[i]
		if b < 0x20 || b == 0x7F {
			return true
		}
	}
	return false
}
