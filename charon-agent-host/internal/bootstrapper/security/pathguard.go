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

// ────────────────────────────────────────────────────────────────────────
// PR-B security hardening: critical-path blocklist + install/data
// directory relationship checks.
//
// The bootstrapper REFUSES to use any drive root, the Windows system
// tree, or the bare roots of Program Files / ProgramData / user
// profile as install or data directories. The list is enumerative
// rather than heuristic so that "is this path safe?" has a
// mechanical answer. Subdirectories of Program Files / ProgramData
// (e.g. "C:\\Program Files\\Charon Agent") remain legal -- those
// are exactly where the bootstrapper expects to install.
//
// Comparison is case-insensitive, trailing-separator-normalised, and
// path-segment aware so that "C:\\Foo" is NOT mistaken for a parent
// of "C:\\Foobar".
//
// Environment expansion (e.g. %WINDIR%) is NOT applied here. The
// CLI parser rejects "%" as a forbidden character because absolute
// Windows paths never legitimately contain it; the caller is
// expected to pass an expanded path.
// ────────────────────────────────────────────────────────────────────────

// forbiddenExact is the set of paths that must be REJECTED as install
// or data directories when matched exactly. Subdirectories of these
// roots are legal (this is how Program Files / ProgramData carry
// the application install).
var forbiddenExact = []string{
	`c:\program files`,
	`c:\program files (x86)`,
	`c:\programdata`,
}

// forbiddenSubtrees is the set of root paths whose entire tree is
// off-limits. Includes the Windows system tree (System32 / SysWOW64
// fall under this), the user profile tree (covers temp + AppData),
// and the Recycle Bin tree.
var forbiddenSubtrees = []string{
	`c:\windows`,
	`c:\users`,
	`c:\$recycle.bin`,
}

// NormalizePathForCompare lowercases the path, replaces forward
// slashes with backslashes, and strips a trailing separator (unless
// the path IS a drive root, e.g. "c:\\"). The result is suitable
// for case-insensitive equality and path-prefix comparison.
//
// This is deliberately NOT filepath.Clean: filepath.Clean uses
// Unix semantics on Linux test runners (treating `\` as a regular
// character), which would silently produce wrong results. Our hand-
// rolled normaliser matches Windows semantics on every host.
func NormalizePathForCompare(p string) string {
	s := strings.ToLower(strings.TrimSpace(p))
	s = strings.ReplaceAll(s, "/", `\`)
	// Strip trailing separator unless the path is exactly a drive
	// root like "c:\\".
	if len(s) > 3 && (strings.HasSuffix(s, `\`) || strings.HasSuffix(s, "/")) {
		s = s[:len(s)-1]
	}
	return s
}

// IsDriveRoot returns true for paths that are exactly a drive
// letter + colon + separator (e.g. "C:\\", "d:\\", "Z:/"). The
// bootstrapper refuses to use a drive root as install or data
// directory.
func IsDriveRoot(p string) bool {
	s := NormalizePathForCompare(p)
	if len(s) != 3 {
		return false
	}
	c := s[0]
	if c < 'a' || c > 'z' {
		return false
	}
	return s[1] == ':' && s[2] == '\\'
}

// IsCriticalPath returns a non-empty reason string when the path is
// in the forbidden set; returns the empty string when the path is
// acceptable. The reason text does NOT include the input path so it
// is safe to surface in logs/error output without leaking operator-
// provided data.
func IsCriticalPath(p string) string {
	s := NormalizePathForCompare(p)
	if IsDriveRoot(p) {
		return "drive root is not allowed as install or data directory"
	}
	for _, forbidden := range forbiddenExact {
		if s == forbidden {
			return "Program Files / Program Files (x86) / ProgramData root is not allowed; use a subdirectory"
		}
	}
	for _, sub := range forbiddenSubtrees {
		if s == sub || strings.HasPrefix(s, sub+`\`) {
			return "Windows system / user profile / Recycle Bin tree is not allowed"
		}
	}
	return ""
}

// IsParentOrEqual reports whether `parent` equals `child`, OR
// `parent` is a strict ancestor directory of `child`, using path-
// segment aware comparison. "C:\\Foo" is NOT considered the parent
// of "C:\\Foobar" -- the comparison appends a separator before the
// prefix check so the boundary is segment-aligned.
func IsParentOrEqual(parent, child string) bool {
	p := NormalizePathForCompare(parent)
	c := NormalizePathForCompare(child)
	if p == "" || c == "" {
		return false
	}
	if p == c {
		return true
	}
	// Append separator if parent is not already a drive root to
	// force segment-aligned comparison. Drive roots already end in
	// `\` after normalisation.
	if !strings.HasSuffix(p, `\`) {
		p += `\`
	}
	return strings.HasPrefix(c, p)
}

// ValidateDirectoryPair returns a non-empty reason when install_dir
// and data_dir collide. Collision means: they are equal, OR one is
// an ancestor of the other (path-segment aware). The function does
// not echo the input paths in the error text so collision diagnostics
// stay safe to log.
func ValidateDirectoryPair(installDir, dataDir string) string {
	switch {
	case NormalizePathForCompare(installDir) == NormalizePathForCompare(dataDir):
		return "install directory and data directory must not be the same path"
	case IsParentOrEqual(installDir, dataDir):
		return "data directory must not be nested inside install directory"
	case IsParentOrEqual(dataDir, installDir):
		return "install directory must not be nested inside data directory"
	default:
		return ""
	}
}
