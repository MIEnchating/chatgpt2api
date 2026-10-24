package httpapi

import (
	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

type videoMaterialField struct {
	name   string
	role   string
	scalar bool
}

// Paths belonging to another mode may point at the same data with a different
// shape. Only the selected mode owns those values in the current request.
func videoContractMaterialFields(contract protocol.VideoModelContract, kind string) []videoMaterialField {
	mode, _ := protocol.VideoContractModeForKind(contract, kind)
	var fields []videoMaterialField
	add := func(name, role string, scalar bool, maximum int) {
		if name != "" && maximum > 0 {
			fields = append(fields, videoMaterialField{name: name, role: role, scalar: scalar})
		}
	}
	switch kind {
	case "image":
		add(contract.Request.FirstFrameField, "first_frame", true, mode.Materials.FirstFrame.Max)
		add(contract.Request.LastFrameField, "last_frame", true, mode.Materials.LastFrame.Max)
	case "reference":
		add(contract.Request.ReferenceImagesField, "reference_image", contract.Request.ReferenceValueType == "scalar", mode.Materials.Image.Max)
		add(contract.Request.ReferenceVideosField, "reference_video", contract.Request.ReferenceValueType == "scalar", mode.Materials.Video.Max)
		add(contract.Request.ReferenceAudiosField, "reference_audio", contract.Request.ReferenceValueType == "scalar", mode.Materials.Audio.Max)
	}
	return fields
}

func videoContractArkReferences(request map[string]any, contract protocol.VideoModelContract, kind string) protocol.ArkVideoReferences {
	refs := protocol.ArkVideoReferences{}
	for _, field := range videoContractMaterialFields(contract, kind) {
		value := videoJSONPathValue(request, field.name)
		switch field.role {
		case "first_frame":
			refs.FirstFrame = util.Clean(value)
		case "last_frame":
			refs.LastFrame = util.Clean(value)
		case "reference_image":
			refs.Images = util.AsStringSlice(value)
		case "reference_video":
			refs.Videos = util.AsStringSlice(value)
		case "reference_audio":
			refs.Audio = util.AsStringSlice(value)
		}
	}
	return refs
}
