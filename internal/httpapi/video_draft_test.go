package httpapi

import (
	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
	"testing"
)

func TestVideoDraftFinalRequestHasNoPromptOrReferences(t *testing.T) {
	for _, driver := range []string{protocol.VideoContractDriverArk, protocol.VideoContractDriverAPIMart} {
		c := protocol.VideoModelContract{Driver: driver, Capability: protocol.VideoModelContractCapability{Resolutions: []string{"480p", "1080p"}}}
		input := map[string]any{"model": "seedance-2.5", "draft_task_id": "upstream-draft", "watermark": true, "prompt": "must not resend", "reference_image_urls": []string{"https://example.test/private.jpg"}, "seconds": 5}
		if err := normalizeVideoContractInput(input, c); err != nil {
			t.Fatal(err)
		}
		request := declaredCanonicalVideoContractRequestPayload(input, c)
		if driver == protocol.VideoContractDriverArk {
			var err error
			request, err = arkVideoRequestFromCanonical(input, request, c)
			if err != nil {
				t.Fatal(err)
			}
		}
		if request["prompt"] != nil || request["seconds"] != nil || request["reference_image_urls"] != nil || request["resolution"] != "1080p" || request["watermark"] != true {
			t.Fatalf("invalid final request: %v", request)
		}
		if driver == protocol.VideoContractDriverArk {
			content := util.AsMapSlice(request["content"])
			if len(content) != 1 || util.Clean(util.StringMap(content[0]["draft_task"])["id"]) != "upstream-draft" {
				t.Fatalf("draft source lost: %v", request)
			}
		}
	}
}

func TestVideoDraftRejectsWrongModelOrProtocol(t *testing.T) {
	for _, test := range []struct{ model, driver string }{{"seedance-2.0", protocol.VideoContractDriverArk}, {"seedance2.5-A", protocol.VideoContractDriverCustom}} {
		if protocol.SupportsVideoDraft(test.model, protocol.VideoModelContract{Driver: test.driver}) {
			t.Fatalf("unsupported workflow accepted: %+v", test)
		}
	}
	variables := translationVariables(map[string]any{"draft": true, "draft_task_id": "sample-id", "generation_mode": "text-to-video"}, nil, "video")
	if variables["mode"] != "draft" || variables["draft_task_id"] != "sample-id" {
		t.Fatal(variables)
	}
}
