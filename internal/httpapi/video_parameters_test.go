package httpapi

import (
	"strings"
	"testing"
)

func TestPublicReferenceURLLengthBoundary(t *testing.T) {
	const maximumURLLength = 2083
	prefix := "https://cdn.example.com/"
	valid := prefix + strings.Repeat("a", maximumURLLength-len(prefix))
	if !isPublicReferenceURL(valid) {
		t.Fatal("maximum-length public reference URL was rejected")
	}
	if isPublicReferenceURL(valid + "a") {
		t.Fatal("overlong public reference URL was accepted")
	}
}

func TestVideoFrameAliasesRemainSeparateFromOrdinaryReferences(t *testing.T) {
	body := map[string]any{
		"first_frame_url":      "https://cdn.example.com/first.png",
		"last_frame_url":       "https://cdn.example.com/last.png",
		"reference_image_urls": []string{"https://cdn.example.com/first.png", "https://cdn.example.com/reference.png"},
	}
	frames := videoFrameAliases(body)
	if len(frames) != 2 || frames[0] != "https://cdn.example.com/first.png" || frames[1] != "https://cdn.example.com/last.png" {
		t.Fatalf("frame aliases = %#v", frames)
	}
	references := removeVideoFrameAliases([]string{"https://cdn.example.com/first.png", "https://cdn.example.com/reference.png"}, frames)
	if len(references) != 1 || references[0] != "https://cdn.example.com/reference.png" {
		t.Fatalf("ordinary references = %#v", references)
	}
}

func TestNormalizeVideoReferenceMode(t *testing.T) {
	for input, want := range map[string]string{
		"reference":      "reference",
		" REFERENCE ":    "reference",
		"first-frame":    "first-frame",
		"image-to-video": "image-to-video",
		"unknown":        "unknown",
	} {
		if got := normalizeVideoReferenceMode(input); got != want {
			t.Fatalf("normalizeVideoReferenceMode(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestPublicReferenceURLRejectsNonCanonicalIPv4Hosts(t *testing.T) {
	for _, value := range []string{
		"http://127.1/a", "http://0177.0.0.1/a", "http://0x7f.0.0.1/a", "http://127.0.0.0x1/a", "http://2130706433/a",
		"http://0x7f000001/a", "http://127.1./a", "http://１２７.０.０.１/a", "http://127。0。0。1/a", "http://localhost。/a",
		"http://008.008.008.008/a", "http://example.123/a", "http://example.0x1/a",
	} {
		if isPublicReferenceURL(value) {
			t.Errorf("noncanonical numeric or local host accepted: %s", value)
		}
	}
	for _, value := range []string{"https://8.8.8.8/a", "https://[2606:4700:4700::1111]/a", "https://cdn.example.com/a", "https://例子.中国/a", "https://127.1.example.com/a"} {
		if !isPublicReferenceURL(value) {
			t.Errorf("public host rejected: %s", value)
		}
	}
}
