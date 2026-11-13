package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

func TestVideoProviderUploadBeforeNewAPISubmit(t *testing.T) {
	for _, scenario := range []struct {
		name, encoding, format, response string
		status                           int
		missingKey, smallLimit           bool
		wantUploads, wantCreates         int
	}{
		{name: "multipart", encoding: "multipart", response: "https://cdn.example.com/asset.png?signature=kept", status: 200, wantUploads: 1, wantCreates: 1},
		{name: "base64-data-url", encoding: "base64", format: "data_url", response: "https://cdn.example.com/asset.png", status: 200, wantUploads: 1, wantCreates: 1},
		{name: "base64-raw", encoding: "base64", format: "raw", response: "https://cdn.example.com/asset.png", status: 200, wantUploads: 1, wantCreates: 1},
		{name: "missing-key", encoding: "multipart", missingKey: true},
		{name: "size-limit", encoding: "multipart", smallLimit: true},
		{name: "invalid-url", encoding: "multipart", response: "http://127.0.0.1/private.png", status: 200, wantUploads: 1},
		{name: "upload-error", encoding: "multipart", status: 413, wantUploads: 1},
		{name: "redirect", encoding: "multipart", status: 307, wantUploads: 1},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			t.Setenv("IMAGE_BASE_URL", "http://127.0.0.1:8090")
			app := newTestApp(t)
			defer app.Close()
			key := "provider-only-secret"
			if scenario.missingKey {
				key = ""
			}

			var pixels bytes.Buffer
			if err := png.Encode(&pixels, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
				t.Fatal(err)
			}
			stored, err := app.storeReferenceUpload(context.Background(), referenceUpload{data: pixels.Bytes()}, ".png", "image/png", "image", "/video-image-references/")
			if err != nil {
				t.Fatal(err)
			}
			reference := util.Clean(stored["url"])
			uploads, creates := 0, 0
			provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				uploads++
				if r.URL.Path != "/v1/uploads" || r.Header.Get("Authorization") != "Bearer provider-only-secret" {
					t.Error("upload used wrong endpoint or credential")
				}
				if scenario.encoding == "multipart" {
					if err := r.ParseMultipartForm(1024); err != nil {
						t.Error(err)
						return
					}
					defer r.MultipartForm.RemoveAll()
					file, _, err := r.FormFile("file")
					if err != nil {
						t.Error(err)
						return
					}
					defer file.Close()
					got, _ := io.ReadAll(file)
					if !bytes.Equal(got, pixels.Bytes()) {
						t.Error("uploaded bytes changed")
					}
				} else {
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						return
					}
					want := base64.StdEncoding.EncodeToString(pixels.Bytes())
					if scenario.format == "data_url" {
						want = "data:image/png;base64," + want
					}
					if videoJSONPathValue(body, "payload.data") != want {
						t.Error("Base64 encoding mismatch")
					}
				}
				if scenario.status == 307 {
					w.Header().Set("Location", "/must-not-follow")
				}
				util.WriteJSON(w, scenario.status, map[string]any{"data": map[string]any{"url": scenario.response}})
			}))
			defer provider.Close()
			relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				creates++
				if r.Header.Get("Authorization") != "Bearer newapi-only-token" {
					t.Error("generation used provider credential")
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				images := util.AsStringSlice(body["image_urls"])
				if len(images) != 3 || images[0] != scenario.response || images[1] != scenario.response || images[2] != "https://public.example.com/existing.png" {
					t.Errorf("material replacement lost order: %#v", images)
				}
				util.WriteJSON(w, 200, map[string]any{"status": "failed", "error": "fixture stopped after creation"})
			}))
			defer relay.Close()
			app.newSafeRelayHTTPClient = func(time.Duration) *http.Client { return provider.Client() }
			contract := protocol.DefaultVideoContracts()[0]
			contract.Transport.LocalMaterial = "url"
			contract.Transport.MaterialTransports = []string{"url"}
			field := "file"
			if scenario.encoding == "base64" {
				field = "payload.data"
			}
			limit := int64(100 << 20)
			if scenario.smallLimit {
				limit = 1
			}
			contract.Transport.MaterialUpload = &protocol.VideoMaterialUpload{BaseURL: provider.URL, Path: "/v1/uploads", Encoding: scenario.encoding, Field: field, URLField: "data.url", Base64Format: scenario.format, MaxBytes: limit}
			contract.Request.ReferenceImagesField = "image_urls"
			// This fixture exercises only the upload/submit boundary, with three allowed references.
			for i := range contract.Generation.Modes {
				if contract.Generation.Modes[i].Kind == "reference" {
					contract.Generation.Modes[i].Materials.Image.Max = 9
					contract.Generation.Modes[i].Materials.Total.Max = 9
				}
			}
			contract.Name = "Upload fixture " + scenario.name
			contract.Models = []string{"upload-fixture/" + scenario.name}
			item, err := app.videoContracts.Create(contract, true)
			if err != nil {
				t.Fatal(err)
			}
			if err := app.videoContracts.SetMaterialUploadAPIKey(item.ID, provider.URL, key); err != nil {
				t.Fatal(err)
			}
			payload := map[string]any{"video_contract": map[string]any{"id": item.ID}, "model": contract.Models[0], "prompt": "upload fixture", "reference_mode": "reference", "reference_image_urls": []string{reference, reference, "https://public.example.com/existing.png"}, "api_key": "newapi-only-token", "relay_base_url": relay.URL, relayCustomEndpointPayloadKey: true, protocol.VideoContractSnapshotPayloadKey: contract}
			before, _ := json.Marshal(payload)
			_, err = app.relayVideoTask(context.Background(), payload)
			if err == nil || uploads != scenario.wantUploads || creates != scenario.wantCreates {
				t.Fatalf("uploads=%d creates=%d err=%v", uploads, creates, err)
			}
			if scenario.missingKey && !strings.Contains(err.Error(), "在此视频契约中配置") {
				t.Errorf("missing credential error=%v", err)
			}
			after, _ := json.Marshal(payload)
			if !bytes.Equal(before, after) {
				t.Fatal("durable payload mutated")
			}
		})
	}
}

func TestVideoProviderUploadUsesEachContractsOwnCredential(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	var pixels bytes.Buffer
	if err := png.Encode(&pixels, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	stored, err := app.storeReferenceUpload(context.Background(), referenceUpload{data: pixels.Bytes()}, ".png", "image/png", "image", "/video-image-references/")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a", "b"} {
		t.Run(name, func(t *testing.T) {
			requests := 0
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.Header.Get("Authorization") != "Bearer supplier-"+name {
					t.Error("credential crossed supplier boundary")
				}
				util.WriteJSON(w, 200, map[string]any{"url": "https://cdn.example.com/" + name + ".png"})
			}))
			defer upstream.Close()
			app.newSafeRelayHTTPClient = func(time.Duration) *http.Client { return upstream.Client() }
			contract := protocol.DefaultVideoContracts()[0]
			contract.Name = "Supplier " + name
			contract.Models = []string{"supplier-" + name}
			contract.Transport.LocalMaterial = "url"
			contract.Transport.MaterialTransports = []string{"url"}
			contract.Transport.MaterialUpload = &protocol.VideoMaterialUpload{BaseURL: upstream.URL, Path: "/v1/uploads", Encoding: "multipart", Field: "file", URLField: "url", MaxBytes: 100 << 20}
			item, err := app.videoContracts.Create(contract, true)
			if err != nil {
				t.Fatal(err)
			}
			if err := app.videoContracts.SetMaterialUploadAPIKey(item.ID, upstream.URL, "supplier-"+name); err != nil {
				t.Fatal(err)
			}
			request := map[string]any{}
			videoSetObjectPath(request, contract.Request.FirstFrameField, util.Clean(stored["url"]))
			if err := app.uploadVideoContractMaterials(withCustomRelayContext(context.Background()), request, contract, "image", item.ID); err != nil {
				t.Fatal(err)
			}
			if videoJSONPathValue(request, contract.Request.FirstFrameField) != "https://cdn.example.com/"+name+".png" || requests != 1 {
				t.Fatal("wrong supplier upload result")
			}
			// A different contract's saved key must never be reused for this supplier.
			other := contract
			other.Name = "Unconfigured " + name
			other.Models = []string{"unconfigured-" + name}
			otherItem, err := app.videoContracts.Create(other, true)
			if err != nil {
				t.Fatal(err)
			}
			if err := app.videoContracts.SetMaterialUploadAPIKey(otherItem.ID, "https://other.example.com", "different-supplier-key"); err != nil {
				t.Fatal(err)
			}
			request = map[string]any{}
			videoSetObjectPath(request, contract.Request.FirstFrameField, util.Clean(stored["url"]))
			err = app.uploadVideoContractMaterials(withCustomRelayContext(context.Background()), request, contract, "image", otherItem.ID)
			if err == nil || requests != 1 {
				t.Fatal("upload reused a key belonging to another contract/address")
			}
		})
	}
}
