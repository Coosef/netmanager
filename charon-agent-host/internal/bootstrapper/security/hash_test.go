package security

import "testing"

func TestHashSHA256Hex_KnownValue(t *testing.T) {
	// sha256("hello") -- well-known fixture.
	got := HashSHA256Hex([]byte("hello"))
	want := "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	if got != want {
		t.Errorf("HashSHA256Hex(hello) = %q, want %q", got, want)
	}
}

func TestHashSHA256Hex_Empty(t *testing.T) {
	got := HashSHA256Hex(nil)
	want := "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if got != want {
		t.Errorf("HashSHA256Hex(nil) = %q, want %q", got, want)
	}
}

func TestNormaliseHexDigest_CaseAndWhitespace(t *testing.T) {
	for _, in := range []string{
		"EFEE8376D217C03081EA3592B2ECC365904329017EB09A8B4D81CA22184FB0F7",
		"efee8376d217c03081ea3592b2ecc365904329017eb09a8b4d81ca22184fb0f7",
		" efee8376d217c03081ea3592b2ecc365904329017eb09a8b4d81ca22184fb0f7 ",
		"EfEe8376D217c03081Ea3592B2eCC365904329017Eb09a8B4D81cA22184Fb0f7",
	} {
		got := NormaliseHexDigest(in)
		want := "efee8376d217c03081ea3592b2ecc365904329017eb09a8b4d81ca22184fb0f7"
		if got != want {
			t.Errorf("NormaliseHexDigest(%q) = %q, want %q", in, got, want)
		}
	}
}
