package security

import (
	"strings"
	"testing"
)

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

// ── PR-B hardening: userinfo / fragment / query reject ──────────────────

func TestValidateBackendURL_RejectsUsernameOnly(t *testing.T) {
	got, err := ValidateBackendURL("https://admin@example.test")
	if err == nil {
		t.Errorf("username-only URL must be rejected; got %q", got)
	}
}

func TestValidateBackendURL_RejectsUsernamePassword(t *testing.T) {
	got, err := ValidateBackendURL("https://admin:secret@example.test")
	if err == nil {
		t.Errorf("user:pass URL must be rejected; got %q", got)
	}
}

func TestValidateBackendURL_RejectsHTTPUsernamePassword(t *testing.T) {
	got, err := ValidateBackendURL("http://admin:secret@10.0.0.1")
	if err == nil {
		t.Errorf("http user:pass URL must be rejected; got %q", got)
	}
}

func TestValidateBackendURL_RejectsPercentEncodedUserinfo(t *testing.T) {
	// %40 is '@' percent-encoded. url.Parse decodes it; if the
	// result has User != nil, our guard catches it.
	got, err := ValidateBackendURL("https://user%40example.com:pwd@host.example.test")
	if err == nil {
		t.Errorf("percent-encoded userinfo URL must be rejected; got %q", got)
	}
}

func TestValidateBackendURL_RejectsEmptyPasswordUserinfo(t *testing.T) {
	got, err := ValidateBackendURL("https://admin:@example.test")
	if err == nil {
		t.Errorf("empty-password userinfo URL must be rejected; got %q", got)
	}
}

func TestValidateBackendURL_ErrorMessageNoSecretLeak(t *testing.T) {
	// The rejection error MUST NOT echo the password / username
	// from the input. A pasted credential should not survive in
	// the error path.
	_, err := ValidateBackendURL("https://admin:supersecretpw@example.test")
	if err == nil {
		t.Fatal("user:pass URL must be rejected")
	}
	msg := err.Error()
	for _, banned := range []string{"admin", "supersecretpw", "supersecret"} {
		if strings.Contains(msg, banned) {
			t.Errorf("error message leaked input value %q: %q", banned, msg)
		}
	}
}

func TestValidateBackendURL_RejectsFragment(t *testing.T) {
	for _, in := range []string{
		"https://example.test#fragment",
		"https://example.test/api#token",
		"https://example.test/path#",
	} {
		if _, err := ValidateBackendURL(in); err == nil {
			t.Errorf("fragment URL not rejected: %q", in)
		}
	}
}

func TestValidateBackendURL_FragmentErrorNoEcho(t *testing.T) {
	_, err := ValidateBackendURL("https://example.test#authtoken123")
	if err == nil {
		t.Fatal("fragment URL must be rejected")
	}
	if strings.Contains(err.Error(), "authtoken123") {
		t.Errorf("error message echoed the fragment: %q", err.Error())
	}
}

func TestValidateBackendURL_RejectsQueryString(t *testing.T) {
	// PR-B hardening: every "?" in the input -- including a bare
	// trailing "?" with no query text -- is rejected. The check is on
	// the raw string, not url.Parse's RawQuery (which is "" for bare
	// "?"). A base backend URL has no place for a query-introducer
	// character.
	for _, in := range []string{
		"https://example.test?q=1",
		"https://example.test/api?token=abc",
		"https://example.test/?",
	} {
		if _, err := ValidateBackendURL(in); err == nil {
			t.Errorf("query string URL not rejected: %q", in)
		}
	}
}

func TestValidateBackendURL_QueryErrorNoEcho(t *testing.T) {
	_, err := ValidateBackendURL("https://example.test?token=supersecretvalue")
	if err == nil {
		t.Fatal("query URL must be rejected")
	}
	if strings.Contains(err.Error(), "supersecretvalue") {
		t.Errorf("error message echoed the query: %q", err.Error())
	}
}

func TestValidateBackendURL_ValidHTTPS_AfterHardening(t *testing.T) {
	// Regression: a clean URL still passes after the new
	// userinfo / fragment / query gates.
	got, err := ValidateBackendURL("https://staging.example.com/api/proxy/")
	if err != nil {
		t.Fatalf("clean URL must still pass: %v", err)
	}
	if got != "https://staging.example.com/api/proxy" {
		t.Errorf("trailing slash normalisation regressed: got %q", got)
	}
}

func TestValidateBackendURL_ValidHTTP_AfterHardening(t *testing.T) {
	got, err := ValidateBackendURL("http://10.2.22.24")
	if err != nil {
		t.Fatalf("clean http URL must still pass: %v", err)
	}
	if got != "http://10.2.22.24" {
		t.Errorf("clean URL changed: got %q", got)
	}
}
