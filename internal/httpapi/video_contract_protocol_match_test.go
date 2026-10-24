package httpapi

import (
	"encoding/json"
	"reflect"
	"testing"

	"chatgpt2api/internal/protocol"
)

func TestGeneratedVideoContractMatchesBuiltInProtocol(t *testing.T) {
	for _, test := range []struct {
		name, driver, createPath, queryPath, wantDriver string
		defaultPaths                                    bool
	}{
		{"compatible gateway", protocol.VideoContractDriverCustom, "/v1/videos", "/v1/videos/{task_id}", protocol.VideoContractDriverOpenAI, true},
		{"explicit built-in defaults", protocol.VideoContractDriverOpenAI, "/v1/videos", "/v1/videos/{task_id}", protocol.VideoContractDriverOpenAI, true},
		{"independent endpoints", protocol.VideoContractDriverCustom, "/vendor/tasks", "/vendor/tasks/{task_id}", protocol.VideoContractDriverCustom, false},
		{"different query endpoint", protocol.VideoContractDriverCustom, "/v1/videos", "/tasks/{task_id}", protocol.VideoContractDriverCustom, false},
		{"built-in override", protocol.VideoContractDriverOpenAI, "/vendor/videos", "/vendor/videos/{task_id}", protocol.VideoContractDriverOpenAI, false},
		{"provider-specific conversion", protocol.VideoContractDriverVolcengine, "/v1/videos", "/v1/videos/{task_id}", protocol.VideoContractDriverVolcengine, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			contract := protocol.DefaultVideoContracts()[0]
			contract.Models = []string{"seedance-document-v1"}
			contract.Driver = test.driver
			contract.Transport.LocalMaterial = "url"
			contract.Transport.CreatePath, contract.Transport.QueryPath = test.createPath, test.queryPath
			data, err := json.Marshal(contract)
			if err != nil {
				t.Fatal(err)
			}
			contracts, err := decodeGeneratedVideoModelContracts(`{"contracts":[`+string(data)+`]}`, "seedance-document-v1")
			if err != nil {
				t.Fatal(err)
			}
			got := contracts[0]
			if got.Driver != test.wantDriver {
				t.Fatalf("driver = %q, want %q", got.Driver, test.wantDriver)
			}
			wantCreate, wantQuery := test.createPath, test.queryPath
			if test.defaultPaths {
				wantCreate, wantQuery = "", ""
			}
			if got.Transport.CreatePath != wantCreate || got.Transport.QueryPath != wantQuery {
				t.Fatalf("unexpected paths: %#v", got.Transport)
			}
			original, err := decodeGeneratedVideoModelContractJSON(data)
			if err != nil {
				t.Fatal(err)
			}
			if original.Driver != test.driver {
				t.Fatal("decoding an explicit contract unexpectedly changed its driver")
			}
			original.Driver = got.Driver
			original.Transport.CreatePath, original.Transport.QueryPath = wantCreate, wantQuery
			if !reflect.DeepEqual(original, got) {
				t.Fatal("protocol selection changed unrelated contract settings")
			}
		})
	}
}

func TestGeneratedVideoContractMatchingPreservesRequests(t *testing.T) {
	for _, transport := range []string{"url", "multipart"} {
		t.Run(transport, func(t *testing.T) {
			contract := protocol.DefaultVideoContracts()[0]
			contract.Driver = protocol.VideoContractDriverCustom
			contract.Transport.LocalMaterial = transport
			contract.Transport.CreatePath, contract.Transport.QueryPath = "/v1/videos", "/v1/videos/{task_id}"
			contract.Request.DurationField = "metadata.seconds"
			contract.Request.DurationValueType = "string"
			matched := matchGeneratedVideoContractProtocol(contract)
			for _, payload := range []map[string]any{
				{"model": "seedance-document-v1", "prompt": "A boat", "seconds": 5},
				{"model": "seedance-document-v1", "prompt": "A boat", "first_frame_url": "https://media.example/first.png", "last_frame_url": "https://media.example/last.png"},
				{"model": "seedance-document-v1", "prompt": "A boat", "reference_image_urls": []string{"https://media.example/image.png"}, "reference_video_urls": []string{"https://media.example/video.mp4"}},
			} {
				before := declaredVideoContractRequestPayload(payload, contract)
				after := declaredVideoContractRequestPayload(payload, matched)
				if !reflect.DeepEqual(before, after) {
					t.Fatalf("request changed: %#v != %#v", before, after)
				}
				createPath, queryPath, err := videoContractDriverPaths(matched, payload)
				if err != nil || createPath != contract.Transport.CreatePath || queryPath != contract.Transport.QueryPath {
					t.Fatalf("runtime endpoints changed: %q %q %v", createPath, queryPath, err)
				}
			}
		})
	}
}
