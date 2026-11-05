package httpapi

import (
	"bytes"
	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http/httptest"
	"testing"
)

func TestGPTImage26Contract(t *testing.T) {
	for _, name := range []string{"gpt-image-2.6-sunburst", "gpt-image-2.6-flare"} {
		t.Run(name, func(t *testing.T) {
			payload := map[string]any{"model": name, "background": "transparent", "complexity": "low", "quality": "max", "output_format": "png", "n": 1}
			if err := validateRelayImageRequest("/v1/images/generations", name, payload, nil); err != nil {
				t.Fatal(err)
			}
			sanitizeRelayImagePayload(payload)
			if payload["background"] != "transparent" || payload["complexity"] != "low" || payload["quality"] != "max" {
				t.Fatalf("lost options: %#v", payload)
			}
			for _, format := range []string{"svg", "gif"} {
				p := map[string]any{"model": name, "output_format": format, "n": 1}
				if err := validateRelayImageRequest("/v1/images/generations", name, p, nil); err != nil {
					t.Fatal(err)
				}
				sanitizeRelayImagePayload(p)
				if p["output_format"] != format {
					t.Fatalf("lost format: %#v", p)
				}
			}
			for _, invalid := range []map[string]any{
				{"complexity": "max"}, {"complexity": "low|medium"}, {"quality": "ultra"}, {"n": 11}, {"frame_count": 9},
				{"output_format": "svg", "stream": true}, {"output_format": "svg", "n": 2},
				{"output_format": "gif", "frame_count": 17}, {"output_format": "gif", "frame_duration_ms": 0},
				{"output_format": "gif", "partial_images": 1}, {"background": "transparent", "output_format": "jpeg"},
			} {
				invalid["model"] = name
				if err := validateRelayImageRequest("/v1/images/generations", name, invalid, nil); err == nil {
					t.Errorf("accepted invalid request: %#v", invalid)
				}
			}
		})
	}
}

func TestGPTImage26MarkupMultipart(t *testing.T) {
	var data bytes.Buffer
	img := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	img.SetNRGBA(0, 0, color.NRGBA{R: 255, A: 255})
	if err := png.Encode(&data, img); err != nil {
		t.Fatal(err)
	}
	markup := "data:image/png;base64," + base64.StdEncoding.EncodeToString(data.Bytes())
	images := []protocol.UploadedImage{{Data: data.Bytes(), Filename: "source.png", ContentType: "image/png"}}
	payload := map[string]any{"model": "gpt-image-2.6-flare", "complexity": "low", "background": "transparent", "markup": markup}
	if err := validateRelayImageRequest("/v1/images/edits", "gpt-image-2.6-flare", payload, images); err != nil {
		t.Fatal(err)
	}
	request, err := relayMultipartRequest(context.Background(), "https://example.test", "/v1/images/edits", "test-key", payload, images)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(request.Body)
	if err != nil {
		t.Fatal(err)
	}
	incoming := httptest.NewRequest("POST", "/api/creation-tasks/image-edits", bytes.NewReader(raw))
	incoming.Header.Set("Content-Type", request.Header.Get("Content-Type"))
	body, references, err := readMultipartImageBody(httptest.NewRecorder(), incoming)
	if err != nil {
		t.Fatal(err)
	}
	options := imageToolOptionsFromBody(body)
	if len(references) != 1 || options.Options.Markup != markup || options.Options.Complexity != "low" || options.Options.Background != "transparent" {
		t.Fatalf("lost multipart parameters: %#v", options.Options)
	}
	payload["input_image_mask"] = markup
	if err := validateRelayImageRequest("/v1/images/edits", "gpt-image-2.6-flare", payload, images); err == nil {
		t.Fatal("accepted markup and mask")
	}
}

func TestGPTImage26SVGResultLocalization(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	data := []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="red"/></svg>`)
	result := map[string]any{"data": []map[string]any{{"b64_json": base64.StdEncoding.EncodeToString(data)}}}
	if err := app.localizeRelayImageResult(context.Background(), service.Identity{ID: "owner"}, result, map[string]any{"model": "gpt-image-2.6-flare", "output_format": "svg"}); err != nil {
		t.Fatal(err)
	}
	items := result["data"].([]map[string]any)
	if items[0]["output_format"] != "svg" || items[0]["b64_json"] != nil {
		t.Fatalf("invalid localized result: %#v", items[0])
	}
	stored, mime, err := app.images.ImageBytes(items[0]["url"].(string), service.ImageAccessScope{All: true})
	if err != nil || mime != "image/svg+xml" || !bytes.Equal(stored, data) {
		t.Fatalf("SVG changed during storage: %s %v", mime, err)
	}
}

func TestGPTImage26PreservesGIFFrameSize(t *testing.T) {
	for _, tc := range []struct{ input, format, want string }{{"256x256", "gif", "256x256"}, {"16:9", "png", "1536x864"}} {
		payload := map[string]any{"model": "gpt-image-2.6-sunburst", "output_format": tc.format, "size": tc.input}
		if err := validateRelayImageRequest("/v1/images/generations", "gpt-image-2.6-sunburst", payload, nil); err != nil {
			t.Fatal(err)
		}
		sanitizeRelayImagePayload(payload)
		if payload["size"] != tc.want {
			t.Fatalf("size = %v, want %s", payload["size"], tc.want)
		}
	}
}
