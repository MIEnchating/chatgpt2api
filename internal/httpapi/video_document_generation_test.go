package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/videocontract"
)

func TestGeneratedVideoContractRejectsRequiredMaterialLoss(t *testing.T) {
	for _, kind := range []string{"text", "image", "reference"} {
		t.Run(kind, func(t *testing.T) {
			contract := protocol.DefaultVideoContracts()[0]
			contract.Models = []string{"document-video-v1"}
			for index := range contract.Generation.Modes {
				mode := &contract.Generation.Modes[index]
				if mode.Kind != kind {
					continue
				}
				if kind == "reference" {
					mode.Materials.FirstFrame = protocol.VideoModelMaterialRange{Min: 1, Max: 1}
				} else {
					mode.Materials.Video = protocol.VideoModelMaterialRange{Min: 1, Max: 1}
				}
			}
			data, _ := json.Marshal(contract)
			if _, err := decodeGeneratedVideoModelContracts(`{"contracts":[`+string(data)+`]}`, "document-video-v1"); err == nil {
				t.Fatal("invalid required material was silently removed")
			}
		})
	}
}

func TestVideoContractBatchCreatePreservesExistingContractsAndDrafts(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	existing := protocol.DefaultVideoContracts()[0]
	existing.Name, existing.Models = "Existing video", []string{"existing-video-v1"}
	item, err := app.videoContracts.Create(existing, true)
	if err != nil {
		t.Fatal(err)
	}
	draft := existing
	draft.Validation.MaxPromptCharacters++
	if _, err := app.videoContracts.SaveDraft(item.ID, draft, true); err != nil {
		t.Fatal(err)
	}
	before, _ := app.videoContracts.List()
	newContract := existing
	newContract.Name, newContract.Models = "New video", []string{"new-video-v1"}
	collision := existing
	collision.Models = []string{"unrelated-video-v2"}
	modelCollision := newContract
	modelCollision.Name, modelCollision.Models = "Model collision", existing.Models
	token := adminSessionToken(t, app)
	submit := func(contracts []videocontract.ImportedVideoModelContract) *httptest.ResponseRecorder {
		data, _ := json.Marshal(map[string]any{"contracts": contracts})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/video-model-contracts/batch", bytes.NewReader(data))
		setRequestAuthCookie(req, token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}
	for _, conflict := range []protocol.VideoModelContract{collision, newContract, modelCollision} {
		res := submit([]videocontract.ImportedVideoModelContract{{Contract: newContract, Enabled: true}, {Contract: conflict, Enabled: true}})
		if res.Code != http.StatusBadRequest {
			t.Fatalf("conflicting batch accepted: %d %s", res.Code, res.Body.String())
		}
		after, _ := app.videoContracts.List()
		if !reflect.DeepEqual(before, after) {
			t.Fatal("rejected batch changed an existing contract or persisted part of the batch")
		}
		if _, ok := protocol.VideoContractForModel("new-video-v1"); ok {
			t.Fatal("rejected batch changed the active registry")
		}
	}
	res := submit([]videocontract.ImportedVideoModelContract{{Contract: newContract, Enabled: true}})
	if res.Code != http.StatusOK {
		t.Fatalf("valid batch rejected: %d %s", res.Code, res.Body.String())
	}
	after, _ := app.videoContracts.List()
	if len(after) != len(before)+1 {
		t.Fatal("valid batch was not persisted")
	}
	for _, current := range after {
		if current.ID == item.ID && (current.Draft == nil || current.Contract.Models[0] != existing.Models[0]) {
			t.Fatal("successful batch replaced an existing contract or draft")
		}
	}
	if _, ok := protocol.VideoContractForModel("new-video-v1"); !ok {
		t.Fatal("created contract was not activated")
	}
}
