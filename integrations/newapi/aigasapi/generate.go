package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/videocontract"
)

const directory = "integrations/newapi/aigasapi"
const baseURL = "https://www.aigasapi.com"

type catalogModel struct {
	ID                string   `json:"id"`
	BillingMode       string   `json:"billing_mode"`
	PromptMaxLength   int      `json:"prompt_max_length"`
	Durations         []int    `json:"durations"`
	DurationMin       int      `json:"duration_min"`
	DurationMax       int      `json:"duration_max"`
	AspectRatios      []string `json:"aspect_ratios"`
	Resolutions       []string `json:"resolutions"`
	DefaultResolution string   `json:"default_resolution"`
	Watermark         bool     `json:"watermark"`
	References        struct {
		Modes               []string `json:"reference_modes"`
		MaxImages           int      `json:"max_images"`
		MaxVideos           int      `json:"max_videos"`
		MaxAudios           int      `json:"max_audios"`
		MaxTotal            int      `json:"max_total"`
		ImagesRequired      bool     `json:"images_required"`
		AudioRequiresVisual bool     `json:"audio_requires_visual"`
	} `json:"references"`
}

func main() {
	if len(os.Args) != 2 {
		panic("usage: go run ./integrations/newapi/aigasapi OUTPUT_DIRECTORY")
	}
	var catalog struct {
		Models []catalogModel `json:"models"`
	}
	data, err := os.ReadFile(filepath.Join(directory, "source-models.json"))
	check(err)
	check(json.Unmarshal(data, &catalog))

	contract := protocol.VideoModelContract{
		Name: "视频模型（New API）", Driver: "custom-video",
		Transport: protocol.VideoModelContractTransport{
			LocalMaterial: "url", MaterialTransports: []string{"url"},
			CreatePath: "/v1/videos", QueryPath: "/v1/videos/{task_id}",
		},
		Artifact: protocol.VideoModelContractArtifact{
			Mode: "task_content", ContentPath: "/v1/videos/{task_id}/content", Auth: "relay",
		},
		Request: protocol.VideoModelContractRequest{
			DurationField: "duration", DurationValueType: "number", AspectRatioField: "aspect_ratio",
			ResolutionField: "resolution", WatermarkField: "watermark",
			FirstFrameField: "first_frame", LastFrameField: "last_frame",
			ReferenceImagesField: "references.images", ReferenceVideosField: "references.videos", ReferenceAudiosField: "references.audios",
		},
		Polling: protocol.VideoModelContractPolling{
			IntervalSeconds: 5, TimeoutSeconds: 1800,
			TaskIDFields: []string{"id", "task_id"}, StatusFields: []string{"status"}, ProgressFields: []string{"progress"},
			ErrorFields: []string{"error.message"}, QueuedStatuses: []string{"queued"}, RunningStatuses: []string{"in_progress"},
			SuccessStatuses: []string{"completed"}, FailureStatuses: []string{"failed"},
		},
	}
	mapping := make(map[string]string, len(catalog.Models))
	aliases := strings.NewReplacer("官方版", "official", "官转版", "official-relay", "限时特价", "promo")
	modelID := regexp.MustCompile(`^[a-z0-9][a-z0-9.-]+$`)
	for _, model := range catalog.Models {
		id := "video-" + strings.ToLower(aliases.Replace(model.ID))
		// The public catalog has two distinct IDs differing only by the case of P.
		if model.ID == "sd-2.5-flash-720p" {
			id += "-per-request"
		}
		if !modelID.MatchString(id) || mapping[id] != "" {
			panic(fmt.Errorf("invalid or duplicate channel model %q for %q", id, model.ID))
		}
		mapping[id] = model.ID
		contract.Models = append(contract.Models, id)
		// The catalog's 720p conflicts with the model description.
		// MiniMax H3's native API requires the literal 768P for this tier.
		if model.ID == "minimax-h3-官方版-768p" {
			model.Resolutions = []string{"768P"}
			model.DefaultResolution = "768P"
		}
		profile := model.profile(id)
		if len(model.Resolutions) == 0 {
			request := contract.Request
			request.ResolutionField = ""
			profile.Request = &request
		}
		contract.ModelProfiles = append(contract.ModelProfiles, profile)
	}
	if len(contract.ModelProfiles) == 0 {
		panic("empty AIGASAPI video catalog")
	}
	first := contract.ModelProfiles[0]
	contract.Capability, contract.Generation, contract.Rules = first.Capability, first.Generation, first.Rules
	normalized, err := protocol.NormalizeVideoModelContract(contract)
	check(err)
	reports, err := protocol.DryRunVideoModelContracts([]protocol.VideoModelContract{normalized})
	check(err)
	plugin, err := videocontract.GenerateNewAPIVideoPlugin(normalized, videocontract.NewAPIVideoPluginOptions{
		Key: "aigasapi-video", Version: "2.0.3", BaseURL: baseURL, AuthMode: "bearer",
		DownloadMode: "signed_url", ResultFields: []string{"metadata.url"},
	})
	check(err)
	writeJSON("contract.json", struct {
		Version   int                                        `json:"version"`
		Contracts []videocontract.ImportedVideoModelContract `json:"contracts"`
	}{Version: 4, Contracts: []videocontract.ImportedVideoModelContract{{Contract: normalized, Enabled: true}}})
	writeJSON("model-mapping.json", mapping)
	writeJSON("contract-dry-run.json", reports)
	check(os.WriteFile(filepath.Join(os.Args[1], "core.js"), []byte(plugin.Source), 0644))
}

func (model catalogModel) profile(id string) protocol.VideoModelContractProfile {
	capability := protocol.VideoModelContractCapability{
		Prompt: &protocol.VideoPromptConstraint{Required: true, MinLength: 1, MaxLength: model.PromptMaxLength},
		Sizes:  model.AspectRatios, Resolutions: model.Resolutions, DefaultResolution: model.DefaultResolution,
		Seconds: model.Durations, AudioControl: "none", Watermark: model.Watermark,
	}
	switch model.BillingMode {
	case "per_request":
		capability.UsageUnit = "count"
	case "per_second":
		capability.UsageUnit = "second"
	default:
		panic(fmt.Errorf("unsupported billing mode %q for %s", model.BillingMode, model.ID))
	}
	if len(model.Durations) == 0 {
		capability.SecondsRange = &protocol.VideoDurationRange{Min: model.DurationMin, Max: &model.DurationMax, Step: 1}
		capability.DefaultSeconds = model.DurationMin
	} else {
		capability.DefaultSeconds = model.Durations[0]
	}
	if protocol.VideoDurationSupported(capability, 5) {
		capability.DefaultSeconds = 5
	}
	if slices.Contains(model.AspectRatios, "16:9") {
		capability.DefaultSize = "16:9"
	} else if len(model.AspectRatios) > 0 {
		capability.DefaultSize = model.AspectRatios[0]
	}
	if capability.DefaultResolution == "" && len(model.Resolutions) > 0 {
		capability.DefaultResolution = model.Resolutions[0]
	}
	refs := model.References
	modes := []protocol.VideoModelGenerationMode{}
	if !refs.ImagesRequired {
		modes = append(modes, protocol.VideoModelGenerationMode{ID: "text-to-video", Label: "文生视频", Kind: "text"})
	}
	if slices.Contains(refs.Modes, "multi_reference") {
		imgMin := 0
		if refs.ImagesRequired {
			imgMin = 1
		}
		modes = append(modes, protocol.VideoModelGenerationMode{
			ID: "reference-to-video", Label: "参考素材生视频", Kind: "reference",
			Materials: protocol.VideoModelModeMaterials{
				Image: protocol.VideoModelMaterialRange{Min: imgMin, Max: refs.MaxImages},
				Video: protocol.VideoModelMaterialRange{Max: refs.MaxVideos},
				Audio: protocol.VideoModelMaterialRange{Max: refs.MaxAudios},
				Total: protocol.VideoModelMaterialRange{Min: 1, Max: min(refs.MaxTotal, refs.MaxImages+refs.MaxVideos+refs.MaxAudios)},
			},
		})
	}
	if slices.Contains(refs.Modes, "first_frame") || slices.Contains(refs.Modes, "first_last_frame") {
		last := protocol.VideoModelMaterialRange{}
		if slices.Contains(refs.Modes, "first_last_frame") {
			last.Max = 1
			if !slices.Contains(refs.Modes, "first_frame") {
				last.Min = 1
			}
		}
		modes = append(modes, protocol.VideoModelGenerationMode{
			ID: "image-to-video", Label: "首尾帧生视频", Kind: "image",
			Materials: protocol.VideoModelModeMaterials{
				FirstFrame: protocol.VideoModelMaterialRange{Min: 1, Max: 1}, LastFrame: last,
				Total: protocol.VideoModelMaterialRange{Min: 1 + last.Min, Max: 1 + last.Max},
			},
		})
	}
	if len(modes) == 0 {
		panic(fmt.Errorf("no supported video generation modes for %s", model.ID))
	}
	profile := protocol.VideoModelContractProfile{
		Model: id, Capability: capability,
		Generation: protocol.VideoModelContractGeneration{Selection: "infer", DefaultMode: modes[0].ID, Modes: modes},
	}
	if refs.AudioRequiresVisual && refs.MaxAudios > 0 {
		profile.Rules = []protocol.VideoModelContractRule{{
			When:       protocol.VideoModelContractRuleCondition{Field: "reference_audio", Operator: "present"},
			RequireAny: []string{"reference_image", "reference_video"},
			Message:    "该模型的参考音频需要同时提供参考图片或视频",
		}}
	}
	return profile
}

func writeJSON(name string, value any) {
	data, err := json.MarshalIndent(value, "", "  ")
	check(err)
	check(os.WriteFile(filepath.Join(os.Args[1], name), append(data, '\n'), 0644))
}

func check(err error) {
	if err != nil {
		panic(err)
	}
}
