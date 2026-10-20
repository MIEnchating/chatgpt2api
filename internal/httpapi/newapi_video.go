package httpapi

import (
	"net/http"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

// New API's Doubao plugin reads typed Ark media from metadata.content.
// Contract material paths are intermediate inputs, as with ark-seedance.
func newAPIDoubaoVideoRequest(request, payload map[string]any, contract protocol.VideoModelContract) (map[string]any, error) {
	kind, _ := videoContractGenerationKind(payload, contract)
	refs := videoContractArkReferences(request, contract, kind)
	content, err := protocol.ArkVideoContent(util.Clean(request["prompt"]), refs)
	if err != nil {
		return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: err.Error()}
	}
	for _, field := range videoContractMaterialFields(contract, kind) {
		videoDeleteObjectPath(request, field.name)
	}
	// The plugin converts the top-level prompt into its own text content item.
	if len(content) > 1 {
		videoSetObjectPath(request, "metadata.content", content[1:])
	}
	return request, nil
}
