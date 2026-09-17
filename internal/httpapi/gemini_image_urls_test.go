package httpapi

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func TestGoogleGeminiImageItemsExtractsMarkdownURLs(t *testing.T) {
	const imageURL = "https://cdn.example.test/images/cat.png?signature=a%2Fb%3D"
	for _, content := range []any{
		"![image](" + imageURL + ")",
		[]any{map[string]any{"type": "text", "text": "![image](" + imageURL + ")"}},
	} {
		items, err := googleGeminiImageItems(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": content}}},
		}, "draw a cat")
		if err != nil || len(items) != 1 || items[0]["url"] != imageURL || items[0]["revised_prompt"] != "draw a cat" {
			t.Fatalf("googleGeminiImageItems() = %#v, %v", items, err)
		}
	}
}

func TestGoogleGeminiImageItemsPreservesInlineImageWithMarkdownURL(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("image-bytes"))
	items, err := googleGeminiImageItems(map[string]any{
		"choices": []map[string]any{{"message": map[string]any{
			"content": "![inline](data:image/png;base64," + encoded + ")\n![remote](https://cdn.example.test/cat.png)",
		}}},
	}, "draw")
	if err != nil || len(items) != 2 || items[0]["b64_json"] != encoded || items[1]["url"] != "https://cdn.example.test/cat.png" {
		t.Fatalf("mixed Gemini images = %#v, %v", items, err)
	}
}

func TestGoogleGeminiImageItemsReportsTextWithoutImage(t *testing.T) {
	const message = "See [help](https://example.test/help)"
	_, err := googleGeminiImageItems(map[string]any{
		"choices": []map[string]any{{"message": map[string]any{"content": message}}},
	}, "draw")
	if err == nil || !strings.Contains(err.Error(), message) {
		t.Fatalf("text-only Gemini error = %v, want original text", err)
	}
}

func TestRunLoggedGeminiImageTaskLocalizesMarkdownURL(t *testing.T) {
	for _, downloadFails := range []bool{false, true} {
		t.Run(map[bool]string{false: "saved", true: "download failure"}[downloadFails], func(t *testing.T) {
			imageData := httpTestPNGBytes(t)
			var generations, downloads atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/chat/completions":
					generations.Add(1)
					util.WriteJSON(w, http.StatusOK, map[string]any{
						"choices": []map[string]any{{"message": map[string]any{
							"content": "![image](http://" + r.Host + "/generated/cat.png?signature=test%2Bvalue)",
						}}},
					})
				case "/generated/cat.png":
					downloads.Add(1)
					if r.URL.RawQuery != "signature=test%2Bvalue" {
						t.Errorf("image query changed: %q", r.URL.RawQuery)
					}
					if r.Header.Get("Authorization") != "" {
						t.Error("image download received upstream API credentials")
					}
					if downloadFails {
						http.Error(w, "expired", http.StatusForbidden)
						return
					}
					w.Header().Set("Content-Type", "image/png")
					_, _ = w.Write(imageData)
				default:
					t.Errorf("unexpected upstream request: %s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer upstream.Close()
			app := newTestApp(t)
			defer app.Close()
			if _, err := app.config.Update(map[string]any{"relay_base_url": upstream.URL}); err != nil {
				t.Fatal(err)
			}
			identity := service.Identity{ID: "gemini-url-owner", Role: service.AuthRoleUser, Name: "Alice"}
			result, err := app.runLoggedImageTask(context.Background(), identity, map[string]any{
				"api_key": "sk-test", "model": "gemini-3.1-flash-image", "prompt": "draw a cat", "n": 1,
				"visibility": service.ImageVisibilityPrivate,
			}, "/api/creation-tasks/image-generations", "文生图", func(ctx context.Context, payload map[string]any) (map[string]any, error) {
				return app.relayImageCreationTask(ctx, payload, nil, false)
			})
			if generations.Load() != 1 || downloads.Load() != 1 {
				t.Fatalf("requests: generations=%d downloads=%d", generations.Load(), downloads.Load())
			}
			if downloadFails {
				if err == nil || !strings.Contains(err.Error(), "image download failed: 403") {
					t.Fatalf("download error = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			items := util.AsMapSlice(result["data"])
			if len(items) != 1 || !app.isLocalImageURL(util.Clean(items[0]["url"])) || items[0]["output_format"] != "png" {
				t.Fatalf("localized Gemini result = %#v", result)
			}
			access, err := app.images.ImageFileAccess(util.Clean(items[0]["url"]), service.ImageAccessScope{OwnerID: identity.ID})
			if err != nil {
				t.Fatal(err)
			}
			if access.OwnerID != identity.ID || access.Visibility != service.ImageVisibilityPrivate || access.Info.Size() == 0 {
				t.Fatalf("localized image access = %#v", access)
			}
		})
	}
}
