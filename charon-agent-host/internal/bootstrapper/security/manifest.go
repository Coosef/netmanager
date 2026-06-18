package security

// ManifestStub is a placeholder for the detached runtime manifest
// (PR #2 schema, see backend/app/services/windows_runtime/manifest.py).
// PR-B does not download or parse the real manifest; the type only
// exists so that the resolver interface in
// `internal/bootstrapper/runtime` can reference a concrete name in
// PR-C without breaking the import graph.
//
// Real fields will be added in PR-C; until then the stub carries
// only the fields the bootstrapper's plan layer is allowed to
// surface in its JSON output -- nothing sensitive.
type ManifestStub struct {
	RuntimeVersion string `json:"runtime_version,omitempty"`
	ZipSize        uint64 `json:"zip_size_bytes,omitempty"`
	ZipSHA256      string `json:"zip_sha256,omitempty"`
}
