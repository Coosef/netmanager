package security

import "testing"

func TestValidateBackendURL_AcceptsClean(t *testing.T) {
	for _, in := range []string{
		"https://staging.example.com",
		"http://10.2.22.24",
		"https://gw.example.com:8443",
		"https://example.com/api/proxy",
	} {
		got, err := ValidateBackendURL(in)
		if err != nil {
			t.Errorf("ValidateBackendURL(%q): expected accept, got %v", in, err)
		}
		if got != in {
			t.Errorf("ValidateBackendURL(%q) = %q, expected unchanged", in, got)
		}
	}
}

func TestValidateBackendURL_StripsTrailingSlash(t *testing.T) {
	got, err := ValidateBackendURL("https://staging.example.com/")
	if err != nil {
		t.Fatalf("expected accept: %v", err)
	}
	if got != "https://staging.example.com" {
		t.Errorf("trailing slash not stripped: got %q", got)
	}
}

func TestValidateBackendURL_StripsTrailingSlashPathPrefix(t *testing.T) {
	got, err := ValidateBackendURL("https://gw.example.com/api/proxy/")
	if err != nil {
		t.Fatalf("expected accept: %v", err)
	}
	if got != "https://gw.example.com/api/proxy" {
		t.Errorf("path trailing slash not stripped: got %q", got)
	}
}

func TestValidateBackendURL_RejectsEmpty(t *testing.T) {
	if _, err := ValidateBackendURL(""); err == nil {
		t.Error("empty URL must be rejected")
	}
	if _, err := ValidateBackendURL("   "); err == nil {
		t.Error("whitespace URL must be rejected")
	}
	if _, err := ValidateBackendURL("/"); err == nil {
		t.Error("slash-only URL must be rejected")
	}
}

func TestValidateBackendURL_RejectsNonHTTPSchemes(t *testing.T) {
	for _, in := range []string{
		"ftp://example.com",
		"javascript:alert(1)",
		"file:///etc/passwd",
		"data:text/plain,foo",
		"ssh://user@host",
	} {
		if _, err := ValidateBackendURL(in); err == nil {
			t.Errorf("scheme not rejected: %q", in)
		}
	}
}

func TestValidateBackendURL_RejectsForbiddenCharacters(t *testing.T) {
	for _, in := range []string{
		`https://x.com';dropdb`,
		`https://x.com"`,
		`https://x.com|whoami`,
		"https://x.com`id`",
		`https://x.com$VAR`,
		`https://x.com&touch`,
		`https://x.com\backslash`,
		"https://x.com\nnewline",
		"https://x.com\rcr",
		`https://x.com<tag>`,
		`https://x.com space`,
	} {
		if _, err := ValidateBackendURL(in); err == nil {
			t.Errorf("forbidden char not rejected: %q", in)
		}
	}
}

func TestValidateBackendURL_RejectsControlCharacters(t *testing.T) {
	if _, err := ValidateBackendURL("https://x.com\x00"); err == nil {
		t.Error("NUL byte must be rejected")
	}
	if _, err := ValidateBackendURL("https://x.com\x07"); err == nil {
		t.Error("BEL byte must be rejected")
	}
}

func TestValidateBackendURL_RejectsMissingHost(t *testing.T) {
	for _, in := range []string{
		"https://",
		"http://",
	} {
		if _, err := ValidateBackendURL(in); err == nil {
			t.Errorf("missing host not rejected: %q", in)
		}
	}
}
