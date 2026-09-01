package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"chatgpt2api/internal/util"
)

func TestProfileAssetItemAPIKeepsConcurrentGenerationWrites(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	identity, token := createPasswordUserSession(t, app, "asset-race", "Password123", "Asset Race")
	video, err := app.storageFiles.Upload(context.Background(), identity.ID, false, "race.mp4", "video/mp4", []byte("video fixture"), nil)
	if err != nil {
		t.Fatalf("Upload(video fixture) error = %v", err)
	}

	request := func(method, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/profile/assets", strings.NewReader(body))
		setRequestAuthCookie(req, "Bearer "+token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}
	manual := `{"item":{"id":"manual","kind":"image","title":"旧快照","url":"/images/manual.png","tags":[]}}`
	if res := request(http.MethodPost, manual); res.Code != http.StatusOK {
		t.Fatalf("seed asset status = %d body = %s", res.Code, res.Body.String())
	}

	bodies := []string{
		`{"item":{"id":"manual","kind":"image","title":"旧标签页改名","url":"/images/manual.png","tags":[]}}`,
		fmt.Sprintf(`{"item":{"id":"generated-video:task-race:0","kind":"video","title":"并发生成结果","url":%q,"storageKey":%q,"mimeType":"video/mp4","tags":[]}}`, video.URL, video.StorageKey),
	}
	var wait sync.WaitGroup
	statuses := make(chan int, len(bodies))
	for _, body := range bodies {
		wait.Add(1)
		go func() {
			defer wait.Done()
			statuses <- request(http.MethodPost, body).Code
		}()
	}
	wait.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusOK {
			t.Fatalf("concurrent item mutation status = %d", status)
		}
	}

	if res := request(http.MethodDelete, `{"id":"manual"}`); res.Code != http.StatusOK {
		t.Fatalf("delete asset status = %d body = %s", res.Code, res.Body.String())
	}
	res := request(http.MethodGet, "")
	if res.Code != http.StatusOK {
		t.Fatalf("list assets status = %d body = %s", res.Code, res.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("list assets json: %v", err)
	}
	items := logItems(payload)
	if len(items) != 1 || util.Clean(items[0]["id"]) != "generated-video:task-race:0" {
		t.Fatalf("assets after concurrent update and delete = %#v", items)
	}
	if res := request(http.MethodPut, `{"items":[]}`); res.Code != http.StatusMethodNotAllowed {
		t.Fatalf("legacy table PUT status = %d body = %s", res.Code, res.Body.String())
	}
}
