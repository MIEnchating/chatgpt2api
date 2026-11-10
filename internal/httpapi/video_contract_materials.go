package httpapi

import (
	"encoding/base64"
	"fmt"
	"slices"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

// Encode temporary references only when constructing the upstream request.
// Durable task payloads keep signed file references instead of Base64 bytes.
func (a *App) encodeVideoContractBase64Materials(request map[string]any, contract protocol.VideoModelContract, kind string) error {
	if contract.Transport.LocalMaterial != "base64" {
		return nil
	}
	seen := map[string]bool{}
	for _, field := range videoContractMaterialFields(contract, kind) {
		if seen[field.name] {
			continue
		}
		seen[field.name] = true
		value := videoJSONPathValue(request, field.name)
		values := slices.Clone(util.AsStringSlice(value))
		if field.scalar && util.Clean(value) != "" {
			values = []string{util.Clean(value)}
		}
		for i, value := range values {
			file, local, err := a.localVideoReferenceFile(value)
			if err != nil {
				return err
			}
			if !local {
				return fmt.Errorf("Base64 素材必须先暂存为平台文件")
			}
			encoded := base64.StdEncoding.EncodeToString(file.Data)
			if contract.Transport.Base64Format != "raw" {
				encoded = "data:" + file.ContentType + ";base64," + encoded
			}
			values[i] = encoded
		}
		if len(values) == 0 {
			continue
		}
		if field.scalar {
			videoSetObjectPath(request, field.name, values[0])
		} else {
			videoSetObjectPath(request, field.name, values)
		}
	}
	return nil
}

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
