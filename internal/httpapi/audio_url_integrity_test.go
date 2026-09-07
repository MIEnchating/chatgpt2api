package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestAudioResultPreservesSignedURLWhileLogRedactsIt(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	const signedURL = "https://media.example.test/voice.mp3?signature=private-signature&expires=123456"
	result, err := app.storeGeneratedAudioJSON(strings.NewReader(fmt.Sprintf(`{"data":[{"url":%q}]}`, signedURL)), "openai", "mp3")
	if err != nil {
		t.Fatal(err)
	}
	data := util.AsMapSlice(result["data"])
	if len(data) != 1 || data[0]["url"] != signedURL {
		t.Fatalf("signed audio URL was changed: %#v", result)
	}
	app.logCall(context.Background(), service.Identity{ID: "owner"}, "audio-url-test", http.MethodPost, "/api/creation-tasks/audio-generations", "tts-1", time.Now(), "success", http.StatusOK, "", collectURLs(result), auditRequestCapture{})
	page, err := app.logs.SearchPage(service.LogQuery{Summary: "audio-url-test", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || strings.Contains(fmt.Sprint(page.Items), "private-signature") || !strings.Contains(fmt.Sprint(page.Items), "media.example.test/voice.mp3") {
		t.Fatalf("audio log was not correctly redacted: %#v", page.Items)
	}
}
