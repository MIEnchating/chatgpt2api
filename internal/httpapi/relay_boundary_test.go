package httpapi

import (
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type relayDoneBoundaryBody struct {
	reader       *strings.Reader
	readPastDone bool
	closed       bool
}

func (b *relayDoneBoundaryBody) Read(p []byte) (int, error) {
	if b.reader.Len() == 0 {
		b.readPastDone = true
		return 0, errors.New("connection failed after completed stream")
	}
	return b.reader.Read(p)
}

func (b *relayDoneBoundaryBody) Close() error {
	b.closed = true
	return nil
}

func TestRelayStreamResultStopsAtDone(t *testing.T) {
	for _, suffix := range []string{"", "data: {\"error\":\"late transport error\"}\n\n"} {
		t.Run(suffix, func(t *testing.T) {
			body := &relayDoneBoundaryBody{reader: strings.NewReader("data: {\"id\":\"completed\"}\n\ndata: [DONE]\n\n" + suffix)}
			stream := relayStreamResult(body)
			var count int
			for item := range stream.Items {
				count++
				if item["id"] != "completed" {
					t.Errorf("unexpected item: %#v", item)
				}
			}
			if err := <-stream.Err; err != nil {
				t.Errorf("completed stream returned error: %v", err)
			}
			if count != 1 || body.readPastDone || !body.closed {
				t.Fatalf("count=%d readPastDone=%v closed=%v", count, body.readPastDone, body.closed)
			}
		})
	}
}

func TestStoreRelayVideoStreamRejectsEmptyContentWithoutReplacingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "existing.mp4")
	if err := os.WriteFile(path, []byte("existing video"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := storeRelayVideoStream(dir, "existing.mp4", strings.NewReader(""), 1024); err == nil {
		t.Error("empty video content was accepted")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "existing video" {
		t.Errorf("existing video changed: data=%q error=%v", data, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("temporary file cleanup failed: entries=%v error=%v", entries, err)
	}
	if err := storeRelayVideoStream(dir, "new.mp4", strings.NewReader(""), 1024); err == nil {
		t.Error("new empty video content was accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "new.mp4")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("empty video artifact exists: %v", err)
	}
}

func TestNormalizeRelayImageSizeRejectsNonFiniteRatios(t *testing.T) {
	for _, input := range []string{"nan:1", "1:nan", "inf:1", "1:inf", "inf:inf", "1e308:1e-308", "1e-308:1e308"} {
		t.Run(input, func(t *testing.T) {
			if value, ok := normalizeRelayImageSize(input); ok || value != "" {
				t.Fatalf("normalizeRelayImageSize(%q) = %q, %v", input, value, ok)
			}
		})
	}
}

func TestNormalizeRelayImageSizePreservesLargeFiniteRatio(t *testing.T) {
	for input, want := range map[string]string{"1e308:5e307": "1536x768", "5e307:1e308": "768x1536"} {
		if value, ok := normalizeRelayImageSize(input); !ok || value != want {
			t.Errorf("normalizeRelayImageSize(%q) = %q, %v; want %q", input, value, ok, want)
		}
	}
}

func TestNormalizeRelayImageDimensionsPreservesRatioAtIntegerLimit(t *testing.T) {
	for _, test := range []struct {
		width, height int
		want          string
	}{
		{math.MaxInt, math.MaxInt / 2, "3840x1920"},
		{math.MaxInt / 2, math.MaxInt, "1920x3840"},
		{math.MaxInt, math.MaxInt, "2880x2880"},
	} {
		if got := normalizeRelayImageDimensions(test.width, test.height); got != test.want {
			t.Errorf("normalizeRelayImageDimensions(%d, %d) = %q; want %q", test.width, test.height, got, test.want)
		}
	}
}

var _ io.ReadCloser = (*relayDoneBoundaryBody)(nil)
