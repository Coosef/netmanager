package security

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// HashSHA256Hex returns the lowercase 64-character hex digest of
// the input bytes. The bootstrapper's manifest layer (PR-C) will
// use this to compare against the on-disk .sha256 sidecar files.
func HashSHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// NormaliseHexDigest lowercases + trims a SHA-256 hex digest string
// from a sidecar file or manifest entry so that equality is case-
// insensitive. The PR #2 manifest schema stores zip_sha256 in
// uppercase; the .sha256 sidecar is lowercase; the normaliser lets
// the bootstrapper compare them without caring.
func NormaliseHexDigest(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}
