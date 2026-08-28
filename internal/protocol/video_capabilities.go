package protocol

import (
	_ "embed"
	"encoding/json"
	"strings"
)

//go:embed video_capabilities.json
var videoCapabilitiesJSON []byte

type VideoCapabilityProfile struct {
	Sizes                []string `json:"sizes"`
	Seconds              []int    `json:"seconds"`
	Resolutions          []string `json:"resolutions"`
	DefaultSize          string   `json:"default_size"`
	DefaultSeconds       int      `json:"default_seconds"`
	DefaultResolution    string   `json:"default_resolution"`
	FirstFrameImageLimit int      `json:"first_frame_image_limit"`
	ReferenceMode        bool     `json:"reference_mode"`
	AudioControl         string   `json:"audio_control"`
	Watermark            bool     `json:"watermark"`
	References           struct {
		Image int `json:"image"`
		Video int `json:"video"`
		Audio int `json:"audio"`
	} `json:"references"`
}

type videoCapabilityDocument struct {
	Version  int                               `json:"version"`
	Request  map[string]any                    `json:"request"`
	Profiles map[string]VideoCapabilityProfile `json:"profiles"`
}

var videoCapabilityProfiles = func() map[string]VideoCapabilityProfile {
	var document videoCapabilityDocument
	if err := json.Unmarshal(videoCapabilitiesJSON, &document); err != nil {
		panic(err)
	}
	return document.Profiles
}()

// CanonicalVideoModel mirrors the aliases accepted by the reference project's
// video integrations. Keeping aliases at the shared protocol boundary ensures
// capability lookup, validation, and provider adaptation use the same model
// contract instead of treating an alias as an unknown vendor model.
func CanonicalVideoModel(model string) string {
	name := strings.ToLower(strings.TrimSpace(model))
	aliases := map[string]string{
		"kling/text-to-video":                   "kling-2.6/text-to-video",
		"kling/image-to-video":                  "kling-2.6/image-to-video",
		"kling/motion-control":                  "kling-2.6/motion-control",
		"kling/motion-control-v3":               "kling-3.0/motion-control",
		"kling/kling-3-0":                       "kling-3.0/video",
		"kling/v25-turbo-image-to-video-pro":    "kling/v2-5-turbo-image-to-video-pro",
		"kling/v25-turbo-text-to-video-pro":     "kling/v2-5-turbo-text-to-video-pro",
		"bytedance/seedance-1-5-pro":            "bytedance/seedance-1.5-pro",
		"grok-imagine/1-5-preview":              "grok-imagine-video-1-5-preview",
		"grok-imagine/grok-imagine-1.5-preview": "grok-imagine-video-1-5-preview",
		"grok-imagine-1.5-video":                "grok-imagine-video-1-5-preview",
		"grok-imagine-1.5-preview":              "grok-imagine-video-1-5-preview",
	}
	if canonical, ok := aliases[name]; ok {
		return canonical
	}
	return strings.TrimSpace(model)
}

func VideoModelProfile(model string) string {
	name := strings.ToLower(CanonicalVideoModel(model))
	if strings.HasPrefix(name, "bytedance/v1-") {
		if strings.Contains(name, "image-to-video") {
			return "bytedance-v1-i2v"
		}
		if strings.Contains(name, "text-to-video") {
			return "bytedance-v1-t2v"
		}
	}
	if strings.Contains(name, "seedance") || strings.Contains(name, "doubao-seedance") {
		switch {
		case strings.Contains(name, "2-5") || strings.Contains(name, "2.5") || strings.Contains(name, "seedance-2-5"):
			return "seedance-25"
		case strings.Contains(name, "2-0") || strings.Contains(name, "2.0") || strings.HasSuffix(name, "seedance-2") || strings.Contains(name, "seedance-2-"):
			if strings.Contains(name, "fast") {
				return "seedance-20-fast"
			}
			if strings.Contains(name, "mini") {
				return "seedance-20-mini"
			}
			return "seedance-20"
		case strings.Contains(name, "1-5") || strings.Contains(name, "1.5"):
			return "seedance-15"
		case strings.Contains(name, "1-0") || strings.Contains(name, "1.0"):
			return "seedance-10"
		default:
			if strings.Contains(name, "fast") {
				return "seedance-20-fast"
			}
			if strings.Contains(name, "mini") {
				return "seedance-20-mini"
			}
			return "seedance-20"
		}
	}
	if strings.Contains(name, "kling") {
		if strings.Contains(name, "ai-avatar") {
			return "kling-avatar"
		}
		if strings.Contains(name, "motion-control") {
			return "kling-motion"
		}
		if strings.Contains(name, "omni") || strings.Contains(name, "video-o1") {
			switch {
			case strings.Contains(name, "transformation"):
				return "kling-omni-transformation"
			case strings.Contains(name, "reference-to-video"):
				return "kling-omni-reference"
			case strings.Contains(name, "image-to-video"):
				return "kling-omni-image"
			case strings.Contains(name, "text-to-video"):
				return "kling-omni-text"
			default:
				return "kling-omni"
			}
		}
		if strings.HasPrefix(name, "kling-2.6/") {
			return "kling-kie-26"
		}
		if strings.HasPrefix(name, "kling/v3-") {
			return "kling-kie-v3"
		}
		if strings.Contains(name, "v3") || strings.Contains(name, "3-0") || strings.Contains(name, "3.0") {
			return "kling-3"
		}
		if strings.HasPrefix(name, "kling/v1-") || strings.HasPrefix(name, "kling/v2-") {
			return "kling-kie-legacy"
		}
		if strings.Contains(name, "kling-v1") || strings.Contains(name, "kling-v2") || strings.Contains(name, "kling-1") || strings.Contains(name, "kling-2") || strings.Contains(name, "kling/v1") || strings.Contains(name, "kling/v2") {
			return "kling-legacy"
		}
		return "vendor-unknown"
	}
	if strings.Contains(name, "minimax") || strings.Contains(name, "hailuo") || strings.HasPrefix(name, "t2v-") || strings.HasPrefix(name, "i2v-") || strings.HasPrefix(name, "s2v-") {
		if strings.Contains(name, "h3") {
			return "minimax-h3"
		}
		return "minimax-hailuo"
	}
	if strings.Contains(name, "grok") {
		if strings.Contains(name, "1.5") || strings.Contains(name, "1-5") {
			return "grok-15"
		}
		if name == "grok-imagine" || name == "grok-imagine-video" || name == "grok-imagine-video-latest" {
			return "grok"
		}
		if name == "grok-imagine/image-to-video" {
			return "grok-i2v"
		}
		if name == "grok-imagine/text-to-video" {
			return "grok-kie"
		}
		return "vendor-unknown"
	}
	if strings.HasPrefix(name, "models/veo-3.1") || strings.Contains(name, "veo3.1") || strings.Contains(name, "veo-3.1") {
		return "veo-31"
	}
	if strings.Contains(name, "veo") {
		return "veo"
	}
	if strings.Contains(name, "wan2") || strings.Contains(name, "wan/2") || strings.Contains(name, "wan-2") {
		if strings.Contains(name, "speech-to-video") {
			return "wan-speech"
		}
		if strings.Contains(name, "animate-move") || strings.Contains(name, "animate-replace") {
			return "wan-animate"
		}
		if strings.Contains(name, "r2v") || strings.Contains(name, "reference-to-video") {
			return "wan-27-r2v"
		}
		if strings.Contains(name, "videoedit") || strings.Contains(name, "video-edit") {
			return "wan-videoedit"
		}
		if strings.Contains(name, "v2v") || strings.Contains(name, "video-to-video") {
			return "wan-v2v"
		}
		isI2V := strings.Contains(name, "i2v") || strings.Contains(name, "image-to-video")
		if isI2V && (strings.Contains(name, "2.7") || strings.Contains(name, "2-7") || strings.Contains(name, "/2-7")) {
			if strings.Contains(name, "wan/2-7") {
				return "wan-27-kie-i2v"
			}
			return "wan-27-i2v"
		}
		if isI2V {
			return "wan-i2v"
		}
		if strings.HasPrefix(name, "wan/") && strings.Contains(name, "text-to-video") {
			return "wan-kie-t2v"
		}
		return "wan-t2v"
	}
	if strings.Contains(name, "viduq3") || strings.Contains(name, "vidu-q3") {
		return "vidu-q3"
	}
	if strings.Contains(name, "vidu") {
		return "vidu"
	}
	if strings.Contains(name, "gemini-omni") || strings.Contains(name, "omni-flash") {
		return "gemini-omni"
	}
	if strings.Contains(name, "pixverse") {
		return "pixverse"
	}
	if strings.Contains(name, "skyreels") {
		return "skyreels"
	}
	if strings.Contains(name, "happyhorse") {
		return "happyhorse"
	}
	if strings.Contains(name, "infinitalk") {
		return "infinitalk"
	}
	if strings.Contains(name, "topaz") && strings.Contains(name, "video") {
		return "topaz-video"
	}
	if strings.Contains(name, "flux-3-video") {
		return "flux-3-video"
	}
	if strings.Contains(name, "jimeng") || strings.Contains(name, "即梦") {
		return "jimeng"
	}
	if strings.Contains(name, "sora") {
		if strings.Contains(name, "sora-2") || strings.Contains(name, "sora_2") {
			if strings.Contains(name, "pro") {
				return "sora-pro"
			}
			return "sora"
		}
		return "vendor-unknown"
	}
	if name == "cogvideox-3" || name == "cogvideo-x3" || strings.Contains(name, "cogvideox-3") {
		return "cogvideox-3"
	}
	agnesName := strings.NewReplacer(".", "-", "_", "-", "/", "-").Replace(name)
	if agnesName == "agnes-video-2-5" {
		return "agnes-25"
	}
	if strings.Contains(name, "agnes-video") {
		return "agnes"
	}
	return "generic"
}

func VideoCapability(model string) VideoCapabilityProfile {
	model = CanonicalVideoModel(model)
	profile := videoCapabilityProfiles[VideoModelProfile(model)]
	name := strings.ToLower(strings.TrimSpace(model))
	switch {
	case strings.HasPrefix(name, "bytedance/v1-"):
		if strings.Contains(name, "text-to-video") {
			profile.FirstFrameImageLimit = 0
		} else {
			profile.FirstFrameImageLimit = 1
		}
		if strings.Contains(name, "v1-lite-image-to-video") {
			profile.FirstFrameImageLimit = 2
		}
	case strings.HasPrefix(name, "hailuo/02-image-to-video"):
		profile.FirstFrameImageLimit = 2
		profile.Seconds = []int{5, 10}
		profile.DefaultSeconds = 5
	case strings.HasPrefix(name, "hailuo/02-text-to-video"):
		profile.Seconds = []int{5, 10}
		profile.DefaultSeconds = 5
		profile.Resolutions = nil
		profile.DefaultResolution = ""
		clearVideoReferences(&profile)
	case name == "kling-2.6/motion-control" || name == "kling-3.0/motion-control":
		// KIE derives duration from the driving clip and does not accept the
		// APIMart motion-control quality/mode selector.
		profile.Resolutions = nil
		profile.DefaultResolution = ""
	case strings.HasPrefix(name, "hailuo/2-3-image-to-video"):
		profile.FirstFrameImageLimit = 1
	case strings.Contains(name, "minimax-hailuo-2-3") || strings.Contains(name, "minimax-hailuo-2.3"):
		profile.FirstFrameImageLimit = 1
	case name == "kling/v3-turbo-image-to-video":
		profile.Sizes, profile.DefaultSize = nil, ""
		profile.FirstFrameImageLimit = 2
	case name == "kling/v3-turbo-text-to-video":
		// KIE's v3 Turbo text endpoint accepts aspect_ratio, not pixel sizes.
		profile.Sizes, profile.DefaultSize = []string{"16:9", "9:16", "1:1"}, "16:9"
		profile.FirstFrameImageLimit = 0
	case name == "kling-2.6/image-to-video":
		profile.FirstFrameImageLimit = 2
	case name == "kling-2.6/text-to-video":
		profile.FirstFrameImageLimit = 0
	case name == "kling/v2-1-master-text-to-video" || name == "kling/v2-5-turbo-text-to-video-pro":
		profile.FirstFrameImageLimit = 0
	case name == "kling/v2-1-pro" || name == "kling/v2-5-turbo-image-to-video-pro":
		profile.FirstFrameImageLimit = 2
	case name == "kling/v2-1-master-image-to-video" || name == "kling/v2-1-standard":
		profile.FirstFrameImageLimit = 1
	case name == "grok-imagine/text-to-video":
		profile.FirstFrameImageLimit = 0
	case name == "minimax-h3/text-to-video":
		clearVideoReferences(&profile)
	case name == "minimax-h3/image-to-video":
		profile.Sizes, profile.DefaultSize = nil, ""
		profile.FirstFrameImageLimit = 2
		profile.ReferenceMode = false
		profile.References.Image = 0
		profile.References.Video = 0
		profile.References.Audio = 0
	case name == "minimax-h3/reference-to-video":
		profile.FirstFrameImageLimit = 0
	case name == "grok-imagine/image-to-video":
		profile.FirstFrameImageLimit = 9
		profile.References.Image = 9
		profile.References.Video = 0
		profile.References.Audio = 0
	case name == "happyhorse/text-to-video" || name == "happyhorse-1-1/text-to-video":
		clearVideoReferences(&profile)
	case name == "happyhorse/image-to-video":
		profile.Sizes, profile.DefaultSize = nil, ""
		profile.FirstFrameImageLimit = 9
		profile.ReferenceMode = false
		profile.References.Image = 0
		profile.References.Video = 0
		profile.References.Audio = 0
	case name == "happyhorse-1-1/image-to-video":
		profile.Sizes, profile.DefaultSize = nil, ""
		profile.FirstFrameImageLimit = 1
		profile.ReferenceMode = false
		profile.References.Image = 0
		profile.References.Video = 0
		profile.References.Audio = 0
	case name == "happyhorse/reference-to-video" || name == "happyhorse-1-1/reference-to-video":
		profile.FirstFrameImageLimit = 0
		profile.References.Image, profile.References.Video, profile.References.Audio = 9, 0, 0
	case name == "happyhorse/video-edit":
		profile.Sizes, profile.DefaultSize = nil, ""
	}
	if name == "bytedance/seedance-2" || name == "bytedance/seedance-2-fast" || name == "bytedance/seedance-2-mini" || name == "bytedance/seedance-2-5" {
		profile.FirstFrameImageLimit = 2
	}
	if name == "wan/2-7-image-to-video" {
		profile.FirstFrameImageLimit = 2
	}
	// KIE model endpoints do not share the generic provider profile. Keep the
	// server-side validation in lockstep with the creator UI and official input
	// configuration.
	switch {
	case name == "kling-2.6/image-to-video":
		profile.Sizes = nil
		profile.Resolutions = nil
		profile.DefaultSize, profile.DefaultResolution = "", ""
		profile.Seconds, profile.DefaultSeconds = []int{5, 10}, 5
	case name == "kling-2.6/text-to-video":
		profile.Sizes = []string{"16:9", "9:16", "1:1"}
		profile.Resolutions = nil
		profile.DefaultSize, profile.DefaultResolution = "16:9", ""
		profile.Seconds, profile.DefaultSeconds = []int{5, 10}, 5
	case name == "kling/v2-1-master-image-to-video", name == "kling/v2-1-pro", name == "kling/v2-1-standard", name == "kling/v2-5-turbo-image-to-video-pro":
		profile.Sizes = nil
		profile.Resolutions = nil
		profile.DefaultSize, profile.DefaultResolution = "", ""
		profile.Seconds, profile.DefaultSeconds = []int{5, 10}, 5
	case name == "kling/v2-1-master-text-to-video", name == "kling/v2-5-turbo-text-to-video-pro":
		profile.Sizes = []string{"16:9", "9:16", "1:1"}
		profile.Resolutions = nil
		profile.DefaultSize, profile.DefaultResolution = "16:9", ""
		profile.Seconds, profile.DefaultSeconds = []int{5, 10}, 5
	case strings.Contains(name, "grok-imagine-video-1.5") || strings.Contains(name, "grok-imagine-video-1-5"):
		profile.References.Image, profile.References.Video, profile.References.Audio = 9, 0, 0
		profile.FirstFrameImageLimit, profile.ReferenceMode = 9, false
		profile.AudioControl = "none"
	case name == "gemini-omni-video":
		// KIE expects provider-issued audio_ids here, not public audio URLs.
		// The shared creation contract only accepts public reference URLs, so
		// advertising audio support would create a request that must fail later.
		profile.References.Image, profile.References.Video, profile.References.Audio = 9, 3, 0
		profile.FirstFrameImageLimit, profile.ReferenceMode = 1, true
	case strings.Contains(name, "vidu"):
		// APIMart normalizes Vidu images to first and last frame fields.
		profile.References.Image, profile.References.Video, profile.References.Audio = 0, 0, 0
		profile.FirstFrameImageLimit, profile.ReferenceMode = 2, false
	case name == "bytedance/seedance-1.5-pro":
		profile.FirstFrameImageLimit = 9
	case strings.HasPrefix(name, "wan/2-6-"):
		profile.Resolutions = []string{"480p", "720p", "1080p"}
		profile.DefaultResolution = "720p"
		profile.Seconds, profile.DefaultSeconds = []int{5, 10}, 5
		profile.Watermark = false
		// The reference workbench exposes generated-audio only for the two
		// concrete KIE Wan 2.6 flash endpoints. Other 2.6 variants may accept
		// a reference audio asset, but that is not the generation toggle.
		if name == "wan/2-6-flash-image-to-video" || name == "wan/2-6-flash-video-to-video" {
			profile.AudioControl = "toggle"
		} else {
			profile.AudioControl = "none"
		}
		switch {
		case strings.Contains(name, "text-to-video"):
			if name == "wan/2-6-text-to-video" {
				profile.Sizes, profile.DefaultSize = nil, ""
			} else {
				profile.Sizes = []string{"16:9", "9:16", "1:1", "4:3", "3:4"}
				profile.DefaultSize = "16:9"
			}
			clearVideoReferences(&profile)
		case strings.Contains(name, "video-to-video"):
			profile.Sizes, profile.DefaultSize = nil, ""
			profile.References.Image, profile.References.Video, profile.References.Audio = 0, 1, 0
			profile.FirstFrameImageLimit, profile.ReferenceMode = 0, true
		default:
			profile.Sizes, profile.DefaultSize = nil, ""
			profile.References.Image, profile.References.Video, profile.References.Audio = 9, 0, 0
			profile.FirstFrameImageLimit, profile.ReferenceMode = 9, false
		}
	case name == "wan/2-5-image-to-video":
		profile.Sizes, profile.DefaultSize = nil, ""
		profile.Resolutions, profile.DefaultResolution = []string{"480p", "720p", "1080p"}, "720p"
		profile.Seconds, profile.DefaultSeconds = []int{5, 10}, 5
		profile.References.Image, profile.References.Video, profile.References.Audio = 0, 0, 0
		profile.FirstFrameImageLimit, profile.ReferenceMode = 1, false
		profile.AudioControl, profile.Watermark = "none", false
	case name == "wan/2-5-text-to-video":
		profile.Sizes, profile.DefaultSize = []string{"16:9", "9:16", "1:1", "4:3", "3:4"}, "16:9"
		profile.Resolutions, profile.DefaultResolution = []string{"480p", "720p", "1080p"}, "720p"
		profile.Seconds, profile.DefaultSeconds = []int{5, 10}, 5
		clearVideoReferences(&profile)
	case strings.HasPrefix(name, "wan/2-2-a14b-") || strings.HasPrefix(name, "wan/2-2-animate-"):
		profile.Seconds, profile.DefaultSeconds = []int{5}, 5
		profile.Resolutions, profile.DefaultResolution = []string{"480p", "720p", "1080p"}, "720p"
		if strings.Contains(name, "text-to-video") {
			profile.Sizes, profile.DefaultSize = []string{"16:9", "9:16", "1:1", "4:3", "3:4"}, "16:9"
		} else {
			profile.Sizes, profile.DefaultSize = nil, ""
		}
		profile.Watermark = false
		if strings.Contains(name, "image-to-video") {
			profile.References.Image, profile.References.Video, profile.References.Audio = 0, 0, 0
			profile.FirstFrameImageLimit, profile.ReferenceMode = 1, false
			profile.AudioControl = "none"
		} else if strings.Contains(name, "text-to-video") {
			clearVideoReferences(&profile)
			profile.AudioControl = "none"
		}
	}
	// Match the reference workbench's model-specific audio controls. These
	// variants share a family profile but do not expose the same input fields.
	switch {
	case name == "kling-3.0/video":
		profile.Resolutions, profile.DefaultResolution = nil, ""
		profile.FirstFrameImageLimit = 2
		profile.Watermark = false
	case name == "kling-3-0-turbo":
		profile.Sizes = []string{"1280x720", "720x1280", "1024x1024", "1792x1024", "1024x1792"}
		profile.Seconds = make([]int, 30)
		for index := range profile.Seconds {
			profile.Seconds[index] = index + 1
		}
		profile.Resolutions = []string{"720p", "480p", "1080p", "2k", "4k"}
		profile.DefaultSize, profile.DefaultSeconds, profile.DefaultResolution = "1280x720", 6, "720p"
		profile.References.Image, profile.References.Video, profile.References.Audio = 0, 0, 0
		profile.FirstFrameImageLimit, profile.ReferenceMode = 1, false
		profile.AudioControl = "none"
		profile.Watermark = false
	case strings.Contains(name, "viduq3-pro"), strings.Contains(name, "vidu-q3-pro"), strings.Contains(name, "viduq3-turbo"):
		profile.AudioControl = "toggle"
	case strings.Contains(name, "pixverse") && !strings.Contains(name, "pixverse-v6"):
		profile.AudioControl = "none"
	case (VideoModelProfile(name) == "veo" || VideoModelProfile(name) == "veo-31") && !strings.Contains(name, "official"):
		profile.AudioControl = "none"
	case VideoModelProfile(name) == "wan-27-i2v":
		profile.AudioControl = "none"
	case name == "wan2-6-image-to-video" || name == "wan2.6-image-to-video" || name == "wan2-6-video-to-video" || name == "wan2.6-video-to-video":
		profile.AudioControl = "none"
	case name == "wan2-6" || name == "wan2.6" || name == "wan2-6-i2v-flash" || name == "wan2.6-i2v-flash" || name == "wan2-6-flash-image-to-video" || name == "wan2.6-flash-image-to-video" || name == "wan2-6-flash-video-to-video" || name == "wan2.6-flash-video-to-video":
		profile.AudioControl = "toggle"
	case (strings.Contains(name, "wan2-5") || strings.Contains(name, "wan2.5")) && !strings.HasPrefix(name, "wan/"):
		profile.AudioControl, profile.Watermark = "none", false
	case VideoModelProfile(name) == "kling-omni-transformation":
		profile.AudioControl = "toggle"
	}
	if referenceWorkbenchSupportsVideoAudio(model) {
		profile.AudioControl = "toggle"
	} else {
		profile.AudioControl = "none"
	}
	return profile
}

// referenceWorkbenchSupportsVideoAudio mirrors supportsVideoAudioGeneration
// in tigerowo/infinite-canvas. Generated audio is a model-specific option,
// not a capability inherited by every model in a provider family.
func referenceWorkbenchSupportsVideoAudio(model string) bool {
	value := strings.NewReplacer(".", "-", "_", "-", "/", "-").Replace(strings.ToLower(strings.TrimSpace(CanonicalVideoModel(model))))
	if strings.Contains(value, "motion-control") {
		return false
	}
	switch value {
	case "cogvideox-3",
		"kling-2-6-text-to-video",
		"kling-2-6-image-to-video",
		"kling-text-to-video",
		"kling-image-to-video",
		"bytedance-seedance-2",
		"bytedance-seedance-2-fast",
		"bytedance-seedance-2-mini",
		"bytedance-seedance-2-5",
		"wan-2-6-flash-image-to-video",
		"wan-2-6-flash-video-to-video",
		"wan2-6",
		"wan2-6-i2v-flash":
		return true
	}
	return strings.Contains(value, "bytedance-seedance-1-5") ||
		strings.Contains(value, "doubao-seedance-2-5") ||
		strings.Contains(value, "doubao-seedance-2-0") ||
		strings.Contains(value, "doubao-seedance-1-5") ||
		(strings.Contains(value, "veo") && strings.Contains(value, "official")) ||
		strings.Contains(value, "kling-v2-6") ||
		strings.Contains(value, "kling-2-6") ||
		((strings.Contains(value, "kling-v3") || strings.Contains(value, "kling-3-0")) && !strings.Contains(value, "turbo")) ||
		strings.Contains(value, "pixverse-v6") ||
		strings.Contains(value, "viduq3-pro") ||
		strings.Contains(value, "vidu-q3-pro") ||
		strings.Contains(value, "viduq3-turbo")
}

func clearVideoReferences(profile *VideoCapabilityProfile) {
	profile.FirstFrameImageLimit = 0
	profile.ReferenceMode = false
	profile.References.Image = 0
	profile.References.Video = 0
	profile.References.Audio = 0
}

func VideoCapabilitySupports(profile VideoCapabilityProfile, size string, seconds int, resolution string) bool {
	if size != "" && !stringInFold(profile.Sizes, size) {
		return false
	}
	if !intIn(profile.Seconds, seconds) {
		return false
	}
	if resolution != "" && !stringInFold(profile.Resolutions, resolution) {
		return false
	}
	return true
}

func stringInFold(values []string, value string) bool {
	for _, candidate := range values {
		if strings.EqualFold(candidate, value) {
			return true
		}
	}
	return false
}

func intIn(values []int, value int) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
