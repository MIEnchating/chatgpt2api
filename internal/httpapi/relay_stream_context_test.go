package httpapi

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func TestRelayStreamResultContextStopsWhenConsumerIsGone(t *testing.T) {
	nl := strings.Repeat(string(rune(10)), 2)
	body := io.NopCloser(strings.NewReader(`data: {"a":1}` + nl + `data: {"a":2}` + nl))
	ctx, cancel := context.WithCancel(context.Background())
	stream := relayStreamResultContext(ctx, body)
	cancel()
	select {
	case err := <-stream.Err:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("stream error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("reader goroutine did not stop after cancellation")
	}
}
