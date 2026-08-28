package httpapi

import (
	"math"
	"strconv"
	"strings"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
)

type videoProviderAdapter struct {
	name    string
	matches func(string) bool
	apply   func(videoProviderAdapterInput)
}

type videoProviderAdapterInput struct {
	request, metadata, payload                   map[string]any
	refs, referenceVideoURLs, referenceAudioURLs []string
	referenceMode, size, resolution, model       string
	seconds                                      int
}

// Registered in priority order because some provider names overlap (for
// example Hailuo and MiniMax). Adding a provider only requires one adapter.
var videoProviderAdapters = []videoProviderAdapter{
	{name: "sora", matches: func(model string) bool { return isSora2Model(model) }, apply: func(in videoProviderAdapterInput) {
		applySoraVideoRequest(in.request, in.payload, in.refs, in.seconds)
	}},
	{name: "veo", matches: func(model string) bool { return strings.Contains(model, "veo") }, apply: func(in videoProviderAdapterInput) {
		applyVeoVideoRequest(in.request, in.metadata, in.payload, in.refs, in.referenceMode, in.size, in.resolution, in.model, in.seconds)
	}},
	{name: "wan", matches: func(model string) bool {
		return strings.Contains(model, "wan2") || strings.Contains(model, "wan/2") || strings.Contains(model, "wan-2")
	}, apply: func(in videoProviderAdapterInput) {
		applyWanVideoRequest(in.request, in.metadata, in.payload, in.refs, in.referenceVideoURLs, in.referenceAudioURLs, in.size, in.resolution, in.model)
	}},
	{name: "vidu", matches: func(model string) bool { return strings.Contains(model, "vidu") }, apply: func(in videoProviderAdapterInput) {
		applyViduVideoRequest(in.request, in.metadata, in.payload, in.refs, in.size, in.resolution, in.model)
	}},
	{name: "jimeng", matches: func(model string) bool {
		return strings.Contains(model, "jimeng") || strings.Contains(model, "\u5373\u68a6")
	}, apply: func(in videoProviderAdapterInput) {
		applyJimengVideoRequest(in.request, in.metadata, in.refs, in.size)
	}},
	{name: "cogvideox", matches: func(model string) bool {
		value := strings.ToLower(model)
		return strings.Contains(value, "cogvideox-3") || strings.Contains(value, "cogvideo-x3")
	}, apply: func(in videoProviderAdapterInput) {
		applyCogVideoX3Request(in.request, in.payload, in.refs, in.size, in.resolution)
	}},
	{name: "agnes", matches: func(model string) bool { return strings.Contains(model, "agnes-video") }, apply: func(in videoProviderAdapterInput) {
		applyAgnesVideoRequest(in.request, in.payload, in.refs, in.referenceVideoURLs, in.referenceAudioURLs, in.referenceMode, in.size, in.model, in.seconds)
	}},
	{name: "grok", matches: func(model string) bool { return strings.Contains(model, "grok") }, apply: func(in videoProviderAdapterInput) {
		applyGrokVideoRequest(in.request, in.metadata, in.payload, in.refs, in.size, in.resolution, in.model)
	}},
	{name: "gemini-omni", matches: func(model string) bool {
		return strings.Contains(model, "gemini-omni") || strings.Contains(model, "omni-flash")
	}, apply: func(in videoProviderAdapterInput) {
		applyGeminiOmniVideoRequest(in.request, in.metadata, in.payload, in.refs, in.referenceVideoURLs, in.referenceAudioURLs, in.size, in.resolution, in.model)
	}},
	{name: "pixverse", matches: func(model string) bool { return strings.Contains(model, "pixverse") }, apply: func(in videoProviderAdapterInput) {
		applyPixVerseVideoRequest(in.request, in.metadata, in.payload, in.refs, in.referenceMode, in.size, in.resolution, in.model)
	}},
	{name: "skyreels", matches: func(model string) bool { return strings.Contains(model, "skyreels") }, apply: func(in videoProviderAdapterInput) {
		applySkyReelsVideoRequest(in.request, in.metadata, in.refs, in.referenceVideoURLs, in.referenceAudioURLs, in.referenceMode, in.size, in.resolution)
	}},
	{name: "happyhorse", matches: func(model string) bool { return strings.Contains(model, "happyhorse") }, apply: func(in videoProviderAdapterInput) {
		applyHappyHorseVideoRequest(in.request, in.metadata, in.payload, in.refs, in.referenceVideoURLs, in.size, in.resolution, in.model)
	}},
	{name: "infinitalk", matches: func(model string) bool { return strings.Contains(model, "infinitalk") }, apply: func(in videoProviderAdapterInput) {
		applyInfinitalkVideoRequest(in.request, in.metadata, in.refs, in.referenceAudioURLs, in.resolution)
	}},
	{name: "topaz-video", matches: func(model string) bool { return strings.Contains(model, "topaz") && strings.Contains(model, "video") }, apply: func(in videoProviderAdapterInput) {
		applyTopazVideoRequest(in.request, in.metadata, in.referenceVideoURLs)
	}},
	{name: "flux-3-video", matches: func(model string) bool { return strings.Contains(model, "flux-3-video") }, apply: func(in videoProviderAdapterInput) {
		applyFlux3VideoRequest(in.request, in.metadata, in.refs, in.referenceVideoURLs, in.size, in.resolution)
	}},
	{name: "kling", matches: func(model string) bool { return strings.Contains(model, "kling") }, apply: func(in videoProviderAdapterInput) {
		applyKlingVideoRequest(in.request, in.metadata, in.payload, in.refs, in.referenceVideoURLs, in.referenceAudioURLs, in.size, in.resolution, in.model)
	}},
	{name: "minimax", matches: func(model string) bool {
		return strings.Contains(model, "minimax") || strings.Contains(model, "hailuo") || strings.HasPrefix(model, "t2v-") || strings.HasPrefix(model, "i2v-") || strings.HasPrefix(model, "s2v-")
	}, apply: func(in videoProviderAdapterInput) {
		applyMiniMaxVideoRequest(in.request, in.metadata, in.payload, in.refs, in.referenceVideoURLs, in.referenceAudioURLs, in.referenceMode, in.size, in.model)
	}},
	{name: "seedance", matches: func(model string) bool {
		return strings.Contains(model, "seedance") || strings.Contains(model, "doubao-seedance")
	}, apply: func(in videoProviderAdapterInput) {
		applySeedanceVideoRequest(in.request, in.metadata, in.payload, in.refs, in.referenceVideoURLs, in.referenceAudioURLs, in.referenceMode, in.size)
	}},
	{name: "bytedance-v1", matches: func(model string) bool { return strings.HasPrefix(model, "bytedance/v1-") }, apply: func(in videoProviderAdapterInput) {
		applyBytedanceV1VideoRequest(in.request, in.metadata, in.refs, in.size, in.resolution)
	}},
	{name: "generic", matches: func(string) bool { return true }, apply: func(in videoProviderAdapterInput) { applyGenericVideoRequest(in.request, in.payload) }},
}

func videoProviderAdapterForModel(model string) videoProviderAdapter {
	for _, adapter := range videoProviderAdapters {
		if adapter.matches(model) {
			return adapter
		}
	}
	return videoProviderAdapters[len(videoProviderAdapters)-1]
}

// Provider-specific video request shaping lives here so the relay entrypoint
// only owns the shared compatibility envelope and provider dispatch.

func applySoraVideoRequest(request, payload map[string]any, refs []string, seconds int) {
	request["seconds"] = strconv.Itoa(seconds)
	isAPIMart := isAPIMartVideoPayload(payload)
	if len(refs) > 0 {
		if isAPIMart {
			request["image_urls"] = refs[:1]
			delete(request, "size")
			delete(request, "input_reference")
		} else {
			request["input_reference"] = refs[0]
		}
	} else if isAPIMart {
		if size := strings.TrimSpace(util.Clean(request["size"])); size != "" {
			request["aspect_ratio"] = size
			delete(request, "size")
		}
	}
	delete(request, "duration")
	if !isAPIMart {
		// OpenAI's official video API accepts size/seconds but has no generic
		// resolution or aspect-ratio fields.
		delete(request, "resolution")
		delete(request, "aspect_ratio")
	}
}

func applyVeoVideoRequest(request, metadata, payload map[string]any, refs []string, referenceMode, size, resolution, model string, seconds int) {
	name := strings.ToLower(strings.TrimSpace(model))
	isAPIMartOfficial := strings.Contains(name, "veo") && strings.Contains(name, "official")
	isAPIMart := isAPIMartOfficial || isAPIMartVideoPayload(payload) && !strings.Contains(name, "/")
	if isAPIMart {
		// APIMart exposes two Veo contracts: the official variant uses named
		// first/last-frame fields, while the regular variant accepts image_urls.
		// Neither accepts Gemini's camelCase metadata input shape.
		if isAPIMartOfficial {
			if len(refs) > 0 {
				setVideoProviderField(request, metadata, "first_frame_image", refs[0])
			}
			if len(refs) > 1 {
				setVideoProviderField(request, metadata, "last_frame_image", refs[1])
			}
		} else if len(refs) > 0 {
			setVideoProviderField(request, metadata, "image_urls", refs)
		}
	} else if referenceMode == "reference" {
		if len(refs) > 0 {
			metadata["referenceImages"] = refs
		}
	} else if len(refs) > 0 {
		metadata["firstFrame"] = refs[0]
		if len(refs) > 1 {
			metadata["lastFrame"] = refs[1]
		}
	}
	if size != "" {
		if isAPIMart {
			setVideoProviderField(request, metadata, "aspect_ratio", size)
		} else {
			metadata["aspectRatio"] = size
		}
	}
	if resolution != "" {
		if isAPIMart {
			setVideoProviderField(request, metadata, "resolution", resolution)
		} else {
			metadata["resolution"] = normalizeVeoVideoResolution(resolution, model)
		}
	}
	if seconds > 0 {
		if !isAPIMart {
			metadata["durationSeconds"] = seconds
		}
	}
	if value, ok := payload["generate_audio"].(bool); ok {
		if isAPIMartOfficial {
			setVideoProviderField(request, metadata, "generate_audio", value)
		} else if !isAPIMart {
			metadata["generateAudio"] = value
		}
	}
	if !isAPIMart {
		delete(request, "resolution")
	}
	delete(request, "input_reference")
}

func normalizeVeoVideoResolution(value, model string) string {
	normalized := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(value)), "p")
	if normalized == "4k" && protocol.VideoModelProfile(model) == "veo-31" {
		return "4k"
	}
	if normalized == "1080" || normalized == "2k" || normalized == "4k" {
		return "1080p"
	}
	return "720p"
}

func applyWanVideoRequest(request, metadata, payload map[string]any, refs, referenceVideoURLs, referenceAudioURLs []string, size, resolution, model string) {
	parameters := map[string]any{}
	input := map[string]any{}
	name := strings.ToLower(strings.TrimSpace(model))
	isImageToVideo := strings.Contains(name, "i2v") || strings.Contains(name, "image-to-video")
	isReferenceToVideo := strings.Contains(name, "r2v") || strings.Contains(name, "reference-to-video")
	isVideoEdit := strings.Contains(name, "videoedit") || strings.Contains(name, "video-edit")
	isVideoToVideo := strings.Contains(name, "v2v") || strings.Contains(name, "video-to-video")
	isSpeechToVideo := strings.Contains(name, "speech-to-video")
	isAnimate := strings.Contains(name, "animate-move") || strings.Contains(name, "animate-replace")
	isKIEStyle := strings.Contains(name, "/")

	if isKIEStyle {
		// KIE declares the accepted aspect field per endpoint. Do not leak the
		// compatibility envelope's raw size into endpoints without one.
		delete(request, "size")
		switch {
		case isSpeechToVideo:
			if len(refs) > 0 {
				setVideoProviderField(request, metadata, "image_url", refs[0])
			}
			if len(referenceAudioURLs) > 0 {
				setVideoProviderField(request, metadata, "audio_url", referenceAudioURLs[0])
			}
		case isAnimate:
			if len(refs) > 0 {
				setVideoProviderField(request, metadata, "image_url", refs[0])
			}
			if len(referenceVideoURLs) > 0 {
				setVideoProviderField(request, metadata, "video_url", referenceVideoURLs[0])
			}
		case isReferenceToVideo:
			if len(refs) > 0 {
				setVideoProviderField(request, metadata, "reference_image", refs)
			}
			if len(referenceVideoURLs) > 0 {
				setVideoProviderField(request, metadata, "reference_video", referenceVideoURLs)
			}
			if len(referenceAudioURLs) > 0 {
				setVideoProviderField(request, metadata, "reference_voice", referenceAudioURLs[0])
			}
		case isVideoEdit:
			if len(refs) > 0 {
				setVideoProviderField(request, metadata, "reference_image", refs[0])
			}
			if len(referenceVideoURLs) > 0 {
				setVideoProviderField(request, metadata, "video_url", referenceVideoURLs[0])
			}
		case isVideoToVideo:
			if len(referenceVideoURLs) > 0 {
				setVideoProviderField(request, metadata, "video_urls", referenceVideoURLs)
			}
		case isImageToVideo:
			if len(refs) > 0 {
				switch {
				case strings.Contains(name, "/2-7-") || strings.Contains(name, "/2-7/"):
					setVideoProviderField(request, metadata, "first_frame_url", refs[0])
					if len(refs) > 1 {
						setVideoProviderField(request, metadata, "last_frame_url", refs[1])
					}
				case strings.Contains(name, "/2-6-") || strings.Contains(name, "/2-6/"):
					setVideoProviderField(request, metadata, "image_urls", refs)
				default:
					setVideoProviderField(request, metadata, "image_url", refs[0])
				}
			}
			if len(referenceVideoURLs) > 0 && (strings.Contains(name, "/2-7-") || strings.Contains(name, "/2-7/")) {
				setVideoProviderField(request, metadata, "first_clip_url", referenceVideoURLs[0])
			}
			if len(referenceAudioURLs) > 0 && (strings.Contains(name, "/2-7-") || strings.Contains(name, "/2-7/")) {
				setVideoProviderField(request, metadata, "driving_audio_url", referenceAudioURLs[0])
			}
		default:
			if strings.Contains(name, "2-7-text-to-video") && len(referenceAudioURLs) > 0 {
				setVideoProviderField(request, metadata, "audio_url", referenceAudioURLs[0])
			}
		}
	} else {
		if len(refs) > 0 {
			request["images"] = refs
			// APIMart Wan consumes image_urls for the 2.5/2.6 image
			// endpoints. Wan 2.7 uses image roles so first/last frames are
			// not mistaken for ordinary reference images.
			if isVideoEdit {
				request["image_urls"] = refs
			} else if strings.Contains(name, "2.7") || strings.Contains(name, "2-7") {
				if !isVideoEdit {
					roles := make([]map[string]string, 0, len(refs))
					for index, value := range refs {
						role := "reference_image"
						if index == 0 {
							role = "first_frame"
						} else if index == 1 {
							role = "last_frame"
						}
						roles = append(roles, map[string]string{"url": value, "role": role})
					}
					request["image_with_roles"] = roles
				}
			} else {
				request["image_urls"] = refs
			}
			// Wan 2.7 keeps the shared `size` aspect field even for image
			// references. Wan 2.5/2.6 derive the aspect from the source image
			// and must continue dropping it.
			if isImageToVideo && !(strings.Contains(name, "2.7") || strings.Contains(name, "2-7")) {
				delete(request, "size")
			}
		}
		if isReferenceToVideo {
			roles := make([]map[string]string, 0, len(refs))
			for _, value := range refs {
				roles = append(roles, map[string]string{"role": "reference_image", "url": value})
			}
			if len(roles) > 0 {
				request["image_with_roles"] = roles
			}
			if len(referenceVideoURLs) > 0 {
				setVideoProviderField(request, metadata, "video_urls", referenceVideoURLs)
			}
		} else if isVideoEdit || isVideoToVideo || (isImageToVideo && (strings.Contains(name, "2.7") || strings.Contains(name, "2-7"))) {
			if len(referenceVideoURLs) > 0 {
				setVideoProviderField(request, metadata, "video_urls", referenceVideoURLs)
			}
		} else if len(referenceVideoURLs) > 0 {
			setVideoProviderField(request, metadata, "video_urls", referenceVideoURLs)
		}
		if len(referenceAudioURLs) > 0 {
			if isReferenceToVideo {
				if roles, ok := request["image_with_roles"].([]map[string]string); ok && len(roles) > 0 {
					roles[0]["reference_voice"] = referenceAudioURLs[0]
					request["image_with_roles"] = roles
					metadata["image_with_roles"] = roles
					// Keep role data in the request body; metadata remains the
					// compatibility envelope used by existing relays.
				}
			} else if !isVideoEdit {
				request["audio_url"] = referenceAudioURLs[0]
			}
		}
	}

	if isImageToVideo {
		if resolution != "" {
			// Both native APIMart Wan and KIE Wan receive the shared
			// `resolution` value. APIMart's older multipart form calls this
			// input `resolution_name`, then normalizes it to `resolution`.
			request["resolution"] = resolution
			parameters["resolution"] = strings.ToUpper(resolution)
		}
	} else if size != "" && !isImageToVideo && !isSpeechToVideo && !isAnimate && !isVideoToVideo && name != "wan/2-6-text-to-video" {
		if isKIEStyle {
			aspectField := "aspect_ratio"
			if strings.Contains(name, "2-7-text-to-video") {
				aspectField = "ratio"
			}
			setVideoProviderField(request, metadata, aspectField, size)
		} else {
			wanSize := strings.ReplaceAll(strings.ToLower(size), "x", "*")
			request["size"] = wanSize
			parameters["size"] = wanSize
		}
	}
	// APIMart Wan 2.6 text-to-video names the aspect field `aspect_ratio`.
	// Keep the compatibility size/parameters envelope above for older relays,
	// but always expose the provider-native value as well.
	if !isKIEStyle && !isImageToVideo && strings.Contains(name, "2.6") && size != "" {
		request["aspect_ratio"] = size
	}
	if isKIEStyle && resolution != "" && !isImageToVideo {
		parameters["resolution"] = strings.ToUpper(resolution)
	}
	if videoProviderSupportsWatermark(model) {
		if value, ok := payload["watermark"].(bool); ok {
			parameters["watermark"] = value
		}
	}
	if value, ok := payload["generate_audio"].(bool); ok {
		if isKIEStyle {
			if strings.EqualFold(name, "wan/2-6-flash-image-to-video") || strings.EqualFold(name, "wan/2-6-flash-video-to-video") {
				request["audio"] = value
			}
		} else {
			parameters["audio"] = value
		}
	}
	if !isKIEStyle && !isReferenceToVideo && !isVideoEdit && len(referenceAudioURLs) > 0 &&
		(strings.Contains(name, "2.5") || strings.Contains(name, "2-5") ||
			strings.Contains(name, "2.6") || strings.Contains(name, "2-6") ||
			strings.Contains(name, "2.7") || strings.Contains(name, "2-7")) {
		input["audio_url"] = referenceAudioURLs[0]
	}
	if len(parameters) > 0 {
		metadata["parameters"] = parameters
	}
	if len(input) > 0 {
		metadata["input"] = input
	}
	// Wan 2.2 has no duration input in the official KIE schema. Wan 2.5
	// and 2.6 explicitly accept duration (as a string), so leave it for the
	// downstream KIE normalizer to convert rather than dropping it here.
	if isKIEStyle && strings.Contains(name, "/2-2-") {
		delete(request, "duration")
		delete(request, "seconds")
	}
	delete(request, "input_reference")
}

func applyViduVideoRequest(request, metadata, payload map[string]any, refs []string, size, resolution, model string) {
	name := strings.ToLower(strings.TrimSpace(model))
	if len(refs) > 0 {
		request["images"] = refs
		// APIMart and the Q3 KIE endpoint both consume image_urls. Keep the
		// legacy images alias for existing relays, but always expose the
		// provider-native array as well.
		request["image_urls"] = refs
	}
	if size != "" {
		setVideoProviderField(request, metadata, "aspect_ratio", size)
	}
	if resolution != "" {
		setVideoProviderField(request, metadata, "resolution", strings.ToLower(resolution))
	}
	// APIMart Vidu derives the aspect from the input image for every model
	// except Vidu Q3/Q3 Mix. Keeping the shared ratio alongside an image makes
	// the provider reject otherwise valid image-to-video requests.
	if len(refs) > 0 && !strings.Contains(name, "viduq3") && !strings.Contains(name, "vidu-q3") && !strings.Contains(name, "/") {
		delete(request, "size")
		delete(request, "aspect_ratio")
		delete(metadata, "size")
		delete(metadata, "aspect_ratio")
	}
	if strings.Contains(name, "viduq3-pro") || strings.Contains(name, "vidu-q3-pro") || strings.Contains(name, "viduq3-turbo") {
		if value, ok := payload["generate_audio"].(bool); ok {
			setVideoProviderField(request, metadata, "video_generate_audio", value)
		}
	}
	delete(request, "size")
	delete(request, "input_reference")
}

func applyJimengVideoRequest(request, metadata map[string]any, refs []string, size string) {
	if len(refs) > 0 {
		request["images"] = refs
	}
	if size != "" {
		metadata["aspect_ratio"] = size
	}
	delete(request, "input_reference")
}

func applyCogVideoX3Request(request, payload map[string]any, refs []string, size, resolution string) {
	quality := "quality"
	if strings.EqualFold(resolution, "480p") {
		quality = "speed"
	}
	request["quality"] = quality
	request["size"] = normalizeCogVideoX3Size(size, resolution)
	delete(request, "seconds")
	delete(request, "resolution")
	if value, ok := payload["generate_audio"].(bool); ok {
		request["with_audio"] = value
	}
	if len(refs) == 1 {
		request["image_url"] = refs[0]
	} else if len(refs) > 1 {
		request["image_url"] = refs
	}
	delete(request, "input_reference")
}

// CogVideoX-3 accepts a concrete output size while the compatibility API may
// receive either a size, an aspect ratio, or only a resolution. Match the
// reference workbench's fallback order so direct API callers get the same
// output dimensions as the UI.
func normalizeCogVideoX3Size(size, resolution string) string {
	requested := strings.ToLower(strings.TrimSpace(size))
	switch requested {
	case "1280x720", "720x1280", "1024x1024", "1920x1080", "1080x1920", "2048x1080", "3840x2160":
		return requested
	}

	quality := strings.ToLower(strings.TrimSpace(resolution))
	quality = strings.TrimSuffix(quality, "p")
	if quality == "" {
		quality = "720"
	}

	switch requested {
	case "1:1", "square":
		return "1024x1024"
	case "9:16", "3:4", "portrait":
		if quality == "1080" || quality == "2k" || quality == "4k" {
			return "1080x1920"
		}
		return "720x1280"
	case "16:9", "landscape", "":
		if quality == "4k" {
			return "3840x2160"
		}
		if quality == "2k" {
			return "2048x1080"
		}
		if quality == "1080" {
			return "1920x1080"
		}
	}
	return "1280x720"
}

func applyAgnesVideoRequest(request, payload map[string]any, refs, videos, audios []string, referenceMode, size, model string, seconds int) {
	name := strings.NewReplacer(".", "-", "_", "-", "/", "-").Replace(strings.ToLower(strings.TrimSpace(model)))
	delete(request, "duration")
	delete(request, "resolution")
	if name == "agnes-video-2-5" {
		if seconds < 4 {
			seconds = 4
		} else if seconds > 12 {
			seconds = 12
		}
		mode := "text"
		if referenceMode == "reference" {
			mode = "reference"
			if len(refs) > 0 {
				request["images"] = refs
			}
			if len(audios) > 0 {
				request["audios"] = audios
			}
			if len(videos) > 0 {
				items := make([]map[string]any, 0, len(videos))
				for _, value := range videos {
					items = append(items, map[string]any{"url": value})
				}
				request["videos"] = items
			}
		} else if len(refs) > 0 {
			mode = "keyframe"
			request["first_frame"] = refs[0]
			if len(refs) > 1 {
				request["last_frame"] = refs[1]
			}
		}
		request["mode"] = mode
		request["seconds"] = strconv.Itoa(seconds)
		request["size"] = "720P"
		if size == "" || strings.EqualFold(size, "adaptive") {
			size = "16:9"
		}
		request["aspect_ratio"] = size
		return
	}
	frameRate := 24
	if seconds > 18 {
		frameRate = 440 / seconds
		if frameRate < 1 {
			frameRate = 1
		}
	}
	numFrames := seconds*frameRate + 1
	if numFrames < 9 {
		numFrames = 9
	}
	if numFrames > 441 {
		numFrames = 441
	}
	numFrames -= (numFrames - 1) % 8
	request["num_frames"] = numFrames
	request["frame_rate"] = frameRate
	delete(request, "seconds")
	if dimensions := strings.Split(strings.ToLower(size), "x"); len(dimensions) == 2 {
		if width, err := strconv.Atoi(dimensions[0]); err == nil {
			request["width"] = width
		}
		if height, err := strconv.Atoi(dimensions[1]); err == nil {
			request["height"] = height
		}
	}
	delete(request, "size")
	if len(refs) == 1 {
		request["image"] = refs[0]
	} else if len(refs) > 1 {
		request["extra_body"] = map[string]any{"image": refs, "mode": "keyframes"}
	}
	_ = payload
}

func applyGrokVideoRequest(request, metadata, payload map[string]any, refs []string, size, resolution, model string) {
	name := strings.ToLower(strings.TrimSpace(model))
	isAPIMartStyle := !strings.Contains(name, "/") && isAPIMartVideoPayload(payload)
	isGrok2APIStyle := isGrok2APIVideoModel(name) && !isAPIMartStyle
	if isGrok2APIStyle {
		if len(refs) == 1 {
			request["image"] = map[string]any{"url": refs[0]}
		} else if len(refs) > 1 {
			images := make([]map[string]any, 0, len(refs))
			for _, value := range refs {
				images = append(images, map[string]any{"url": value})
			}
			request["reference_images"] = images
		}
		if ratio := normalizeKIEAspectRatio(size); ratio != "" && ratio != "adaptive" && ratio != "auto" {
			request["aspect_ratio"] = ratio
		}
		delete(request, "seconds")
		delete(request, "size")
		return
	}
	if (strings.Contains(name, "image-to-video") || strings.Contains(name, "grok-imagine-video-1.5") || strings.Contains(name, "grok-imagine-video-1-5")) && len(refs) > 0 {
		imageRefs := refs
		if len(imageRefs) > 9 {
			imageRefs = imageRefs[:9]
		}
		setVideoProviderField(request, metadata, "image_urls", imageRefs)
	}
	if strings.HasPrefix(strings.ToLower(model), "grok-imagine/") {
		mode := strings.ToLower(strings.TrimSpace(util.Clean(payload["video_mode"])))
		if mode != "fun" && mode != "spicy" {
			mode = "normal"
		}
		request["mode"] = mode
		metadata["mode"] = mode
	}
	if isAPIMartStyle {
		// APIMart Grok uses `size` for the ratio and `quality` for the video
		// quality. It does not accept KIE's aspect_ratio/resolution pair.
		delete(request, "aspect_ratio")
		delete(metadata, "aspect_ratio")
		if resolution != "" {
			request["quality"] = normalizeAPIMartVideoQuality(resolution)
			delete(request, "resolution")
			delete(metadata, "resolution")
		}
		return
	}
	if size != "" {
		request["aspect_ratio"] = size
		metadata["aspect_ratio"] = size
	}
	if resolution != "" {
		metadata["resolution"] = resolution
	}
}

func isGrok2APIVideoModel(model string) bool {
	switch strings.ToLower(strings.TrimSpace(model)) {
	case "grok-imagine-video", "grok-imagine-video-1.5":
		return true
	default:
		return false
	}
}

func normalizeAPIMartVideoQuality(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	switch value {
	case "480", "480p", "sd", "low":
		return "480p"
	case "720", "720p", "hd", "medium", "standard":
		return "720p"
	case "1080", "1080p", "fhd", "high", "pro":
		return "1080p"
	case "2160", "2160p", "4k", "uhd":
		return "4k"
	default:
		return value
	}
}

func applyKlingVideoRequest(request, metadata, payload map[string]any, refs, videos, audios []string, size, resolution, model string) {
	name := strings.ToLower(strings.TrimSpace(model))
	if name == "kling-3-0-turbo" {
		if len(refs) > 0 {
			setVideoProviderField(request, metadata, "first_frame_image", refs[0])
			delete(request, "size")
		} else if size != "" {
			setVideoProviderField(request, metadata, "aspect_ratio", size)
			delete(request, "size")
		}
		if resolution != "" {
			setVideoProviderField(request, metadata, "resolution", strings.ToLower(resolution))
		}
		delete(request, "input_reference")
		return
	}
	// APIMart compatibility models consume these legacy metadata aliases.
	// KIE endpoints have strict provider-native names and are normalized below.
	if !strings.Contains(name, "/") {
		copyKlingAdvancedVideoFields(metadata, payload)
	}
	if strings.Contains(name, "ai-avatar") {
		if len(refs) > 0 {
			setVideoProviderField(request, metadata, "image_url", refs[0])
		}
		if len(audios) > 0 {
			setVideoProviderField(request, metadata, "audio_url", audios[0])
		}
		delete(request, "duration")
		delete(request, "seconds")
		delete(request, "size")
		delete(request, "resolution")
		return
	}
	if strings.Contains(name, "motion-control") {
		isKIEModel := strings.Contains(name, "/")
		if isKIEModel {
			setVideoProviderField(request, metadata, "input_urls", refs)
			setVideoProviderField(request, metadata, "video_urls", videos)
		} else {
			if len(refs) > 0 {
				setVideoProviderField(request, metadata, "image_url", refs[0])
			}
			if len(videos) > 0 {
				setVideoProviderField(request, metadata, "video_url", videos[0])
			}
		}
		if resolution != "" {
			mode := normalizeKIEKlingMotionControlModeValue(resolution)
			if !isKIEModel {
				mode = "std"
				if strings.EqualFold(resolution, "1080p") || strings.EqualFold(resolution, "1080") {
					mode = "pro"
				}
			}
			setVideoProviderField(request, metadata, "mode", mode)
		}
		if orientation := strings.ToLower(strings.TrimSpace(util.Clean(payload["character_orientation"]))); orientation == "image" || orientation == "video" {
			setVideoProviderField(request, metadata, "character_orientation", orientation)
		}
		delete(request, "duration")
		delete(request, "seconds")
		delete(request, "size")
		delete(request, "resolution")
		return
	}
	if strings.Contains(name, "omni") || strings.Contains(name, "video-o1") {
		variant := ""
		for _, candidate := range []string{"text-to-video", "image-to-video", "reference-to-video", "transformation"} {
			if strings.Contains(name, candidate) {
				variant = candidate
				break
			}
		}
		isKIEModel := strings.Contains(name, "/")
		if (!isKIEModel || variant == "image-to-video" || variant == "reference-to-video" || variant == "transformation") && len(refs) > 0 {
			setVideoProviderField(request, metadata, "image_urls", refs)
		}
		if len(videos) > 0 && (!isKIEModel || variant == "reference-to-video" || variant == "transformation") {
			if isKIEModel {
				setVideoProviderField(request, metadata, "video_urls", videos)
			} else {
				setVideoProviderField(request, metadata, "video_list", buildKlingVideoList(videos))
			}
		}
		if size != "" {
			setVideoProviderField(request, metadata, "aspect_ratio", size)
		}
		if isKIEModel {
			requestedResolution := firstNonEmpty(util.Clean(payload["video_mode"]), resolution)
			if requestedResolution != "" {
				setVideoProviderField(request, metadata, "resolution", normalizeKlingOmniResolution(requestedResolution))
			}
		}
		if value, ok := payload["generate_audio"].(bool); ok {
			setVideoProviderField(request, metadata, "audio", value)
		}
		if isKIEModel {
			applyKIEKlingOmniControls(request, payload, variant)
		}
		switch variant {
		case "image-to-video":
			if len(refs) > 1 {
				setVideoProviderField(request, metadata, "aspect_ratio", "auto")
			}
		case "reference-to-video":
			if len(videos) > 0 {
				setVideoProviderField(request, metadata, "aspect_ratio", "auto")
				setVideoProviderField(request, metadata, "audio", false)
				if len(refs) == 0 && len(util.AsMapSlice(request["elements"])) == 0 {
					delete(request, "duration")
					delete(request, "seconds")
					request["customize_multi_shots"] = false
					delete(request, "multi_prompt")
				}
			}
		case "transformation":
			if len(videos) > 0 && len(refs) == 0 {
				setVideoProviderField(request, metadata, "aspect_ratio", "auto")
				delete(request, "duration")
				delete(request, "seconds")
			}
		}
		delete(request, "size")
		if !isKIEModel {
			delete(request, "resolution")
		}
		return
	}
	if strings.HasPrefix(name, "kling-2.6/") || name == "kling-3.0/video" {
		isImageToVideo := strings.Contains(name, "image-to-video")
		if (isImageToVideo || name == "kling-3.0/video") && len(refs) > 0 {
			setVideoProviderField(request, metadata, "image_urls", refs)
		}
		if size != "" && (!isImageToVideo || name == "kling-3.0/video") {
			setVideoProviderField(request, metadata, "aspect_ratio", size)
		}
		if name == "kling-3.0/video" {
			mode := normalizedKlingVideoMode(util.Clean(payload["video_mode"]), resolution, model)
			setVideoProviderField(request, metadata, "mode", mode)
			applyKIEKlingV3Controls(request, payload)
		}
		if value, ok := payload["generate_audio"].(bool); ok {
			setVideoProviderField(request, metadata, "sound", value)
		}
		delete(request, "size")
		if isImageToVideo {
			delete(request, "aspect_ratio")
			delete(metadata, "aspect_ratio")
		}
		delete(request, "resolution")
		return
	}
	if strings.Contains(name, "/") {
		switch {
		case strings.Contains(name, "v3-turbo-image-to-video"):
			setVideoProviderField(request, metadata, "image_urls", refs)
		case strings.Contains(name, "image-to-video"), name == "kling/v2-1-pro", name == "kling/v2-1-standard":
			if len(refs) > 0 {
				setVideoProviderField(request, metadata, "image_url", refs[0])
			}
			if len(refs) > 1 && (name == "kling/v2-1-pro" || strings.Contains(name, "v2-5-turbo")) {
				setVideoProviderField(request, metadata, "tail_image_url", refs[1])
			}
		default:
			if size != "" {
				setVideoProviderField(request, metadata, "aspect_ratio", size)
			}
		}
		if resolution != "" && strings.Contains(name, "v3-turbo") {
			// KIE's v3 Turbo endpoints accept resolution as a top-level
			// field (the downstream adapter normalizes its value). Keep it
			// visible in the request instead of hiding it only in metadata.
			setVideoProviderField(request, metadata, "resolution", strings.ToLower(resolution))
		}
		delete(request, "size")
		if !strings.Contains(name, "v3-turbo") {
			delete(request, "resolution")
		}
		delete(request, "input_reference")
		return
	}
	mode := normalizedKlingVideoMode(util.Clean(payload["video_mode"]), resolution, model)
	request["mode"] = mode
	metadata["mode"] = mode
	if len(refs) == 0 && size != "" {
		request["aspect_ratio"] = size
		metadata["aspect_ratio"] = size
	}
	if len(refs) > 0 {
		request["image"] = refs[0]
		metadata["image"] = refs[0]
		// APIMart Kling v2/v3 accepts an ordered image_urls array. Keep the
		// legacy image/image_tail aliases for older relays as well.
		request["image_urls"] = refs
	}
	if len(refs) > 1 {
		request["image_tail"] = refs[1]
		metadata["image_tail"] = refs[1]
	}
	if resolution != "" {
		metadata["resolution"] = resolution
	}
	if value, ok := payload["generate_audio"].(bool); ok {
		request["audio"] = value
		metadata["audio"] = value
	}
	if videoProviderSupportsWatermark(model) && isKling3Model(model) {
		if value, ok := payload["watermark"].(bool); ok {
			request["watermark"] = value
			metadata["watermark"] = value
		}
	}
	if !strings.Contains(name, "/") {
		delete(request, "resolution")
		delete(metadata, "resolution")
	}
}

func normalizedKlingVideoMode(value, resolution, model string) string {
	mode := strings.ToLower(strings.TrimSpace(value))
	if mode != "std" && mode != "pro" && mode != "4k" {
		mode = klingVideoMode(resolution, model)
	}
	if mode == "4k" && !isKling3Model(model) {
		return "pro"
	}
	return mode
}

func copyKlingAdvancedVideoFields(metadata, payload map[string]any) {
	for _, key := range []string{"negative_prompt", "multi_shot", "shot_type", "multi_prompt", "element_list", "character_orientation", "video_generate_audio", "preset", "mode"} {
		if value, ok := payload[key]; ok {
			metadata[key] = value
		}
	}
}

// KIE's Kling 3 endpoints do not consume the compatibility names used by the
// workbench. Keep the conversion at the provider boundary so the canvas and
// creator submit the same shared controls without leaking unsupported fields.
func applyKIEKlingV3Controls(request, payload map[string]any) {
	if mode := normalizeKIEKlingV3ModeValue(firstNonEmpty(util.Clean(payload["video_mode"]), util.Clean(payload["mode"]), util.Clean(request["mode"]))); mode != "" {
		request["mode"] = mode
	}
	if value, ok := payload["multi_shot"]; ok {
		request["multi_shots"] = util.ToBool(value)
	} else if value, ok := payload["multi_shots"]; ok {
		request["multi_shots"] = util.ToBool(value)
	}
	delete(request, "multi_shot")
	delete(request, "shot_type")
	if prompts := normalizeKIEKlingMultiPrompt(payload["multi_prompt"], 12); len(prompts) > 0 {
		request["multi_prompt"] = prompts
	} else {
		delete(request, "multi_prompt")
	}
	if elements := normalizeKIEKlingElements(payload["element_list"]); len(elements) > 0 {
		request["kling_elements"] = elements
	} else {
		delete(request, "kling_elements")
	}
	delete(request, "element_list")
	delete(request, "negative_prompt")
}

func applyKIEKlingOmniControls(request, payload map[string]any, variant string) {
	multiShot, hasMultiShot := payload["multi_shot"]
	if !hasMultiShot {
		multiShot, hasMultiShot = payload["multi_shots"]
	}
	multiShotEnabled := util.ToBool(multiShot)
	shotType := strings.ToLower(strings.TrimSpace(util.Clean(payload["shot_type"])))
	custom := multiShotEnabled && shotType == "customize"
	smart := multiShotEnabled && !custom
	if !hasMultiShot {
		custom = util.ToBool(payload["customize_multi_shots"])
		smart = util.ToBool(payload["prefer_multi_shots"])
	}
	if variant == "transformation" {
		delete(request, "customize_multi_shots")
		delete(request, "prefer_multi_shots")
		delete(request, "multi_prompt")
		delete(request, "elements")
		return
	}
	request["customize_multi_shots"] = custom
	if variant == "reference-to-video" {
		delete(request, "prefer_multi_shots")
	} else {
		request["prefer_multi_shots"] = smart
	}
	if custom {
		if prompts := normalizeKIEKlingMultiPrompt(payload["multi_prompt"], 15, 6); len(prompts) > 0 {
			request["multi_prompt"] = prompts
		}
	} else {
		delete(request, "multi_prompt")
	}
	if elements := normalizeKIEKlingElements(payload["element_list"]); len(elements) > 0 && variant != "transformation" {
		request["elements"] = elements
	} else {
		delete(request, "elements")
	}
	delete(request, "negative_prompt")
}

func normalizeKIEKlingV3ModeValue(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "4k":
		return "4K"
	case "pro", "1080", "1080p":
		return "pro"
	case "std", "720", "720p":
		return "std"
	default:
		return ""
	}
}

func normalizeKIEKlingMotionControlModeValue(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "1080p") || strings.EqualFold(strings.TrimSpace(value), "1080") {
		return "1080p"
	}
	return "720p"
}

func normalizeKIEKlingMultiPrompt(value any, maxDuration int, maxItemsValues ...int) []map[string]any {
	items := util.AsMapSlice(value)
	if len(items) == 0 {
		return nil
	}
	result := make([]map[string]any, 0, len(items))
	maxItems := 0
	if len(maxItemsValues) > 0 {
		maxItems = maxItemsValues[0]
	}
	for _, item := range items {
		prompt := strings.TrimSpace(util.Clean(item["prompt"]))
		duration := util.ToInt(item["duration"], 1)
		if duration < 1 {
			duration = 1
		}
		if duration > maxDuration {
			duration = maxDuration
		}
		result = append(result, map[string]any{"prompt": prompt, "duration": duration})
		if maxItems > 0 && len(result) >= maxItems {
			break
		}
	}
	return result
}

func normalizeKIEKlingElements(value any) []map[string]any {
	items := util.AsMapSlice(value)
	if len(items) == 0 {
		return nil
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		inputURLs := util.AsStringSlice(item["element_input_urls"])
		audioURLs := util.AsStringSlice(item["element_input_audio_urls"])
		for _, reference := range util.AsMapSlice(item["references"]) {
			url := strings.TrimSpace(util.Clean(reference["url"]))
			if url == "" {
				continue
			}
			if strings.EqualFold(strings.TrimSpace(util.Clean(reference["kind"])), "audio") {
				audioURLs = append(audioURLs, url)
			} else {
				inputURLs = append(inputURLs, url)
			}
		}
		if len(inputURLs) == 0 && len(audioURLs) == 0 {
			continue
		}
		next := map[string]any{
			"name":        strings.TrimSpace(util.Clean(item["name"])),
			"description": strings.TrimSpace(util.Clean(item["description"])),
		}
		if len(inputURLs) > 0 {
			next["element_input_urls"] = inputURLs
		}
		if len(audioURLs) > 0 {
			next["element_input_audio_urls"] = audioURLs
		}
		result = append(result, next)
	}
	return result
}

func klingVideoMode(resolution, model string) string {
	if strings.EqualFold(resolution, "4k") && isKling3Model(model) {
		return "4k"
	}
	if strings.EqualFold(resolution, "1080p") {
		return "pro"
	}
	return "std"
}

func applyGeminiOmniVideoRequest(request, metadata, payload map[string]any, refs, videos, audios []string, size, resolution, model string) {
	// Only the KIE Gemini endpoint uses its native video_list/audio_ids shape
	// below. APIMart Gemini Omni Flash omits duration later in the final
	// contract cleanup, matching the reference creator request.
	if len(refs) > 0 {
		setVideoProviderField(request, metadata, "image_urls", refs)
	}
	if len(videos) > 0 {
		if strings.Contains(strings.ToLower(model), "gemini-omni-video") {
			items := make([]map[string]any, 0, len(videos))
			for _, value := range videos {
				items = append(items, map[string]any{"url": value, "start": 0, "ends": 10})
			}
			setVideoProviderField(request, metadata, "video_list", items)
		} else {
			setVideoProviderField(request, metadata, "video_urls", videos)
		}
		if strings.Contains(strings.ToLower(model), "omni-flash-ext") {
			delete(request, "duration")
			delete(request, "seconds")
		}
	}
	if ids := util.AsStringSlice(payload["audio_ids"]); len(ids) > 0 {
		setVideoProviderField(request, metadata, "audio_ids", ids)
	}
	// KIE's Gemini Omni endpoint accepts provider-issued `audio_*` IDs here,
	// whereas the shared relay contract carries public audio URLs. Do not map
	// URLs into `audio_ids`; relayVideoTask rejects this unsupported combination
	// before submission with an actionable error.
	if size != "" {
		setVideoProviderField(request, metadata, "aspect_ratio", size)
	}
	if resolution != "" {
		setVideoProviderField(request, metadata, "resolution", strings.ToLower(resolution))
	}
	// APIMart's Gemini Omni Flash schema uses `duration`; the shared relay
	// `seconds` alias must not reach the provider even when the caller did not
	// include an explicit APIMart channel marker.
	if strings.Contains(strings.ToLower(model), "gemini-omni-flash-preview") {
		delete(request, "seconds")
	}
}

func applyPixVerseVideoRequest(request, metadata, payload map[string]any, refs []string, referenceMode, size, resolution, model string) {
	if len(refs) > 0 {
		if referenceMode == "first-frame" {
			setVideoProviderField(request, metadata, "first_frame_image", refs[0])
			if len(refs) > 1 {
				setVideoProviderField(request, metadata, "last_frame_image", refs[1])
			}
		} else if len(refs) == 1 {
			setVideoProviderField(request, metadata, "image_urls", refs)
		} else {
			setVideoProviderField(request, metadata, "img_references", refs)
		}
	}
	if strings.Contains(strings.ToLower(strings.TrimSpace(model)), "pixverse-v6") {
		if value, ok := payload["generate_audio"].(bool); ok {
			setVideoProviderField(request, metadata, "video_generate_audio", value)
		}
	}
	setAPIMartStyleVideoDimensions(request, metadata, "size", size, resolution)
}

func applySkyReelsVideoRequest(request, metadata map[string]any, refs, videos, audios []string, referenceMode, size, resolution string) {
	if len(refs) > 0 && referenceMode == "first-frame" {
		setVideoProviderField(request, metadata, "first_frame_image", refs[0])
		if len(refs) > 1 {
			setVideoProviderField(request, metadata, "end_frame_image", refs[1])
		}
	} else if len(refs) > 0 {
		item := map[string]any{"tag": "@image1", "type": "image", "image_urls": refs}
		if len(audios) > 0 {
			item["audio_url"] = audios[0]
		}
		setVideoProviderField(request, metadata, "ref_images", []map[string]any{item})
	}
	if len(videos) > 0 {
		items := make([]map[string]string, 0, len(videos))
		for index, value := range videos {
			items = append(items, map[string]string{"tag": "@video" + strconv.Itoa(index+1), "type": "reference", "video_url": value})
		}
		setVideoProviderField(request, metadata, "ref_videos", items)
	}
	setAPIMartStyleVideoDimensions(request, metadata, "aspect_ratio", size, resolution)
}

func applyHappyHorseVideoRequest(request, metadata, payload map[string]any, refs, videos []string, size, resolution, model string) {
	name := strings.ToLower(model)
	isAPIMartStyle := !strings.Contains(name, "/")
	frameRefs := videoFrameAliases(payload)
	switch {
	case strings.Contains(name, "video-edit"):
		if len(refs) > 0 {
			setVideoProviderField(request, metadata, "reference_image", refs)
		}
	case strings.Contains(name, "reference-to-video"):
		if len(refs) > 0 {
			setVideoProviderField(request, metadata, "reference_image", refs)
		}
	case strings.Contains(name, "image-to-video"):
		if len(refs) > 0 {
			if strings.Contains(name, "happyhorse-1-1/") {
				setVideoProviderField(request, metadata, "image_urls", refs[:1])
			} else {
				setVideoProviderField(request, metadata, "image_urls", refs)
			}
		}
	case isAPIMartStyle && (len(refs) > 0 || len(frameRefs) > 0):
		if name == "happyhorse-1-1" && len(frameRefs) > 0 {
			// The reference adapter gives a named first frame precedence over the
			// ordinary image array. HappyHorse rejects both modes in one request.
			setVideoProviderField(request, metadata, "first_frame_image", frameRefs[0])
		} else if name == "happyhorse-1-1" || len(refs) > 1 {
			setVideoProviderField(request, metadata, "image_urls", refs)
		} else {
			setVideoProviderField(request, metadata, "first_frame_image", refs[0])
		}
	default:
		// Text-to-video endpoints do not accept image references. The UI and
		// server validation normally remove them, but direct relay callers must
		// not leak unsupported aliases either.
	}
	if strings.Contains(name, "video-edit") && len(videos) > 0 {
		setVideoProviderField(request, metadata, "video_url", videos[0])
	}
	if strings.Contains(name, "video-edit") && strings.Contains(name, "/") {
		delete(request, "duration")
		delete(request, "seconds")
	}
	// KIE image-to-video and video-edit do not declare an aspect field. Do
	// not leak the shared compatibility `size` alias into those inputs.
	if strings.Contains(name, "image-to-video") || strings.Contains(name, "video-edit") {
		delete(request, "size")
		delete(metadata, "size")
	} else if isAPIMartStyle {
		setVideoProviderField(request, metadata, "size", size)
		if resolution != "" {
			setVideoProviderField(request, metadata, "resolution", strings.ToUpper(resolution))
		}
	} else {
		setVideoProviderField(request, metadata, "aspect_ratio", size)
		if resolution != "" {
			setVideoProviderField(request, metadata, "resolution", strings.ToLower(resolution))
		}
	}
}

func applyInfinitalkVideoRequest(request, metadata map[string]any, refs, audios []string, resolution string) {
	if len(refs) > 0 {
		setVideoProviderField(request, metadata, "image_url", refs[0])
	}
	if len(audios) > 0 {
		setVideoProviderField(request, metadata, "audio_url", audios[0])
	}
	if resolution != "" {
		setVideoProviderField(request, metadata, "resolution", strings.ToLower(resolution))
	}
	delete(request, "duration")
	delete(request, "seconds")
	delete(request, "size")
}

func applyTopazVideoRequest(request, metadata map[string]any, videos []string) {
	if len(videos) > 0 {
		setVideoProviderField(request, metadata, "video_url", videos[0])
	}
	delete(request, "duration")
	delete(request, "seconds")
	delete(request, "size")
	delete(request, "resolution")
}

func applyFlux3VideoRequest(request, metadata map[string]any, refs, videos []string, size, resolution string) {
	if len(refs) > 0 {
		setVideoProviderField(request, metadata, "image_urls", refs)
	}
	if len(videos) > 0 {
		setVideoProviderField(request, metadata, "video_url", videos[0])
	}
	setAPIMartStyleVideoDimensions(request, metadata, "aspect_ratio", size, resolution)
}

func setAPIMartStyleVideoDimensions(request, metadata map[string]any, aspectField, size, resolution string) {
	if size != "" {
		setVideoProviderField(request, metadata, aspectField, size)
	}
	if resolution != "" {
		setVideoProviderField(request, metadata, "resolution", strings.ToLower(resolution))
	}
}

func buildKlingVideoList(videos []string) []map[string]string {
	items := make([]map[string]string, 0, len(videos))
	for _, value := range videos {
		items = append(items, map[string]string{"video_url": value, "refer_type": "base", "keep_original_sound": "no"})
	}
	return items
}

func applyMiniMaxVideoRequest(request, metadata, payload map[string]any, refs, referenceVideoURLs, referenceAudioURLs []string, referenceMode, size, model string) {
	if isMiniMaxH3Model(model) {
		name := strings.ToLower(strings.TrimSpace(model))
		protocolName := videoProtocolHint(payload)
		if protocolName == "metaso" {
			applyMiniMaxH3MetasoRequest(request, payload, refs, referenceVideoURLs, referenceAudioURLs, referenceMode, size)
			return
		}
		if name == "minimax-h3" && protocolName == "" && !isAPIMartVideoPayload(payload) {
			applyMiniMaxH3NeutralRelayRequest(request, metadata, refs, referenceVideoURLs, referenceAudioURLs, referenceMode, size)
			return
		}
		// APIMart exposes the bare `minimax-h3` model as one multimodal
		// endpoint. KIE exposes the same family as three slash-qualified
		// endpoints. Do not run the bare model through the legacy Hailuo
		// branch: APIMart expects aspect_ratio plus URL arrays and silently
		// drops references sent under first_frame_image.
		if name == "minimax-h3" && isAPIMartVideoPayload(payload) {
			if size != "" {
				// APIMart documents `adaptive` as a native H3 aspect value. KIE's
				// slash-qualified H3 endpoints use `auto` instead, so do not share
				// that normalization across the two provider contracts.
				ratio := normalizeKIEAspectRatio(size)
				request["aspect_ratio"] = ratio
				delete(request, "size")
			}
			if referenceMode == "reference" || len(referenceVideoURLs) > 0 || len(referenceAudioURLs) > 0 {
				copyVideoReference(request, metadata, "image_urls", refs)
				copyVideoReference(request, metadata, "video_urls", referenceVideoURLs)
				copyVideoReference(request, metadata, "audio_urls", referenceAudioURLs)
			} else if len(refs) > 0 {
				setVideoProviderField(request, metadata, "first_frame_image", refs[0])
				if len(refs) > 1 {
					setVideoProviderField(request, metadata, "last_frame_image", refs[1])
				}
			}
			if resolution := normalizeMiniMaxH3Resolution(util.Clean(payload["resolution"])); resolution != "" {
				request["resolution"] = resolution
			}
			delete(request, "input_reference")
			return
		}
		// KIE exposes H3 as three distinct endpoints. Enforce the endpoint
		// mode even when a legacy caller sends a mixed-media compatibility
		// payload, so `text-to-video` never receives reference arrays.
		if strings.HasSuffix(name, "/text-to-video") {
			referenceMode, refs, referenceVideoURLs, referenceAudioURLs = "first-frame", nil, nil, nil
		} else if strings.HasSuffix(name, "/image-to-video") {
			referenceMode, referenceVideoURLs, referenceAudioURLs = "first-frame", nil, nil
		} else if strings.HasSuffix(name, "/reference-to-video") {
			referenceMode = "reference"
		}
		delete(request, "seconds")
		delete(request, "size")
		if referenceMode == "reference" {
			if size != "" {
				request["aspect_ratio"] = normalizeMiniMaxH3KIERatio(size)
			}
			copyVideoReference(request, metadata, "reference_image_urls", refs)
			copyVideoReference(request, metadata, "reference_video_urls", referenceVideoURLs)
			copyVideoReference(request, metadata, "reference_audio_urls", referenceAudioURLs)
		} else if len(refs) > 0 {
			setVideoProviderField(request, metadata, "first_frame_url", refs[0])
			if len(refs) > 1 {
				setVideoProviderField(request, metadata, "last_frame_url", refs[1])
			}
			if strings.HasPrefix(strings.ToLower(strings.TrimSpace(refs[0])), "data:") {
				request["input_reference"] = refs[0]
			}
		} else {
			request["aspect_ratio"] = normalizeMiniMaxH3KIERatio(size)
		}
		normalizeMiniMaxH3KIERequest(request, strings.HasSuffix(name, "/image-to-video"))
		return
	}
	name := strings.ToLower(strings.TrimSpace(model))
	if strings.HasPrefix(name, "hailuo/02-text-to-video") {
		delete(request, "size")
		delete(request, "ratio")
		delete(request, "resolution")
		delete(metadata, "first_frame_image")
		return
	}
	if strings.HasPrefix(name, "hailuo/") || strings.Contains(name, "minimax-hailuo") {
		// Hailuo image endpoints accept model-specific resolution but no
		// aspect-ratio field.
		delete(request, "size")
		delete(request, "ratio")
		delete(request, "size")
	}
	if strings.Contains(name, "/") && strings.Contains(name, "image-to-video") && len(refs) > 0 {
		setVideoProviderField(request, metadata, "image_url", refs[0])
		if len(refs) > 1 && (strings.HasPrefix(name, "hailuo/02-image-to-video") || strings.HasPrefix(name, "bytedance/v1-lite-image-to-video")) {
			setVideoProviderField(request, metadata, "end_image_url", refs[1])
		}
		delete(request, "input_reference")
	}
	if size != "" && !strings.HasPrefix(name, "hailuo/") && !strings.Contains(name, "minimax-hailuo") {
		request["ratio"] = size
	}
	if len(refs) > 0 && ((strings.Contains(name, "image-to-video") && !strings.HasPrefix(name, "hailuo/")) || strings.HasPrefix(name, "minimax-hailuo")) {
		setVideoProviderField(request, metadata, "first_frame_image", refs[0])
		// APIMart's Hailuo first/last-frame endpoints use named frame fields.
		// Hailuo 2.3 variants are first-frame-only and are excluded here by
		// their dedicated capability/limit.
		if len(refs) > 1 && !strings.Contains(name, "2-3") && !strings.Contains(name, "2.3") {
			setVideoProviderField(request, metadata, "last_frame_image", refs[1])
		}
		delete(request, "input_reference")
	}
	if resolution := util.Clean(payload["resolution"]); resolution != "" {
		normalized := resolution
		if strings.Contains(name, "/") && strings.HasPrefix(name, "hailuo/") {
			normalized = normalizeHailuoVideoResolution(resolution)
		}
		if strings.Contains(name, "/") && strings.HasPrefix(name, "bytedance/seedance-2-5") {
			normalized = normalizeSeedance25VideoResolution(resolution)
		}
		request["resolution"] = normalized
		metadata["resolution"] = normalized
	}
	if videoProviderSupportsWatermark(model) {
		if value, ok := payload["watermark"].(bool); ok {
			request["aigc_watermark"] = value
			metadata["aigc_watermark"] = value
		}
	}
}

func applyMiniMaxH3NeutralRelayRequest(request, metadata map[string]any, refs, videos, audios []string, referenceMode, size string) {
	if size != "" {
		request["size"] = size
	}
	if referenceMode == "reference" || len(videos) > 0 || len(audios) > 0 {
		copyVideoReference(request, metadata, "reference_image_urls", refs)
		copyVideoReference(request, metadata, "reference_video_urls", videos)
		copyVideoReference(request, metadata, "reference_audio_urls", audios)
	} else if len(refs) > 0 {
		request["input_reference"] = refs[0]
		if len(refs) > 1 {
			metadata["last_frame_url"] = refs[1]
		}
	}
}

func applyMiniMaxH3MetasoRequest(request, payload map[string]any, refs, videos, audios []string, referenceMode, size string) {
	content := []map[string]any{{"type": "text", "text": util.Clean(payload["prompt"])}}
	appendMedia := func(kind, role string, values []string) {
		for _, value := range values {
			item := map[string]any{"type": kind, kind: map[string]any{"url": value}}
			if role != "" {
				item["role"] = role
			}
			content = append(content, item)
		}
	}
	if referenceMode == "reference" || len(videos) > 0 || len(audios) > 0 {
		appendMedia("image_url", "reference_image", refs)
		appendMedia("video_url", "reference_video", videos)
		appendMedia("audio_url", "reference_audio", audios)
	} else {
		for index, value := range refs {
			role := "first_frame"
			if index > 0 {
				role = "last_frame"
			}
			appendMedia("image_url", role, []string{value})
			if index == 1 {
				break
			}
		}
	}

	request["content"] = content
	resolution := normalizeMiniMaxH3Resolution(util.Clean(payload["resolution"]))
	if resolution == "" {
		resolution = "768P"
	}
	request["resolution"] = resolution
	request["duration"] = clampVideoInt(util.ToInt(payload["seconds"], 5), 4, 15)
	ratio := normalizeKIEAspectRatio(size)
	if len(refs) > 0 && referenceMode != "reference" {
		ratio = "adaptive"
	} else if ratio == "" || ratio == "adaptive" && len(refs)+len(videos)+len(audios) == 0 {
		ratio = "16:9"
	}
	request["ratio"] = ratio
	for _, key := range []string{
		"prompt", "seconds", "size", "aspect_ratio", "input_reference",
		"first_frame_url", "last_frame_url", "reference_image_urls",
		"reference_video_urls", "reference_audio_urls", "metadata",
	} {
		delete(request, key)
	}
}

func clampVideoInt(value, minimum, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

// Explicit channel protocol always wins. Older creator requests did not carry
// that hint, so their unambiguous APIMart model IDs still use family inference.
func isAPIMartVideoPayload(payload map[string]any) bool {
	if hint := videoProtocolHint(payload); hint != "" {
		return hint == "apimart"
	}
	for _, key := range []string{"channel_base_url", "provider_base_url"} {
		value := strings.ToLower(strings.TrimSpace(util.Clean(payload[key])))
		if value != "" {
			return strings.Contains(value, "apimart")
		}
	}
	// Legacy creator requests do not carry a channel hint. Retain the reference
	// project's APIMart model-family inference for those requests, while any
	// explicit protocol above takes precedence over the model name.
	model := strings.ToLower(strings.TrimSpace(util.Clean(payload["model"])))
	return isKnownAPIMartVideoModel(model)
}

func videoProtocolHint(payload map[string]any) string {
	for _, key := range []string{"provider", "video_provider", "channel_protocol", "protocol"} {
		value := strings.ToLower(strings.TrimSpace(util.Clean(payload[key])))
		if value == "" {
			continue
		}
		for _, protocolName := range []string{"openai", "gemini", "grok2api", "metaso", "apimart", "kie"} {
			if value == protocolName || strings.Contains(value, protocolName) {
				return protocolName
			}
		}
		return value
	}
	return ""
}

func isKnownAPIMartVideoModel(model string) bool {
	if model == "" || strings.Contains(model, "/") {
		return false
	}
	// These bare IDs are KIE contracts in the reference project and must not
	// be mistaken for APIMart's similarly named families.
	if model == "gemini-omni-video" || strings.HasPrefix(model, "grok-imagine-video-1-5") || strings.HasPrefix(model, "grok-imagine-video-1.5") {
		return false
	}
	// These are the bare model families handled by the reference project's
	// APIMart video adapter. KIE equivalents are slash-qualified except for the
	// explicit exclusions above.
	for _, prefix := range []string{
		"doubao-seedance-",
		"seedance-1-",
		"sora-2",
		"minimax-",
		"minimax-hailuo-",
		"skyreels",
		"kling-v",
		"kling-2-",
		"kling-3-",
		"kling-video-o1",
		"happyhorse",
		"gemini-omni-flash-preview",
		"omni-flash",
		"wan2-",
		"wan2.",
		"vidu",
		"pixverse",
		"flux-3-video",
	} {
		if strings.HasPrefix(model, prefix) {
			return true
		}
	}
	if model == "grok-imagine" || model == "grok-imagine-video-latest" {
		return true
	}
	return model == "minimax-h3" || model == "veo3.1" || model == "veo3.1-official"
}

// normalizeMiniMaxH3KIERequest is the final guard for KIE's slash-qualified
// H3 endpoints. APIMart's bare H3 model has a different aspect enum.
func normalizeMiniMaxH3KIERequest(request map[string]any, dropImageRatio bool) {
	delete(request, "generation_mode")
	if resolution := normalizeMiniMaxH3Resolution(util.Clean(request["resolution"])); resolution != "" {
		request["resolution"] = resolution
	}

	ratio := strings.ToLower(strings.TrimSpace(util.Clean(request["aspect_ratio"])))
	if dropImageRatio {
		// H3 image-to-video derives the ratio from the first frame and does not
		// declare a ratio field.
		delete(request, "ratio")
		delete(request, "aspect_ratio")
	} else if ratio != "" {
		request["aspect_ratio"] = normalizeMiniMaxH3KIERatio(ratio)
		delete(request, "ratio")
	}
}

func normalizeMiniMaxH3APIMartRequest(request map[string]any) {
	delete(request, "generation_mode")
	if resolution := normalizeMiniMaxH3Resolution(util.Clean(request["resolution"])); resolution != "" {
		request["resolution"] = resolution
	}
	if ratio := strings.TrimSpace(util.Clean(request["aspect_ratio"])); ratio != "" {
		request["aspect_ratio"] = normalizeKIEAspectRatio(ratio)
	}
	delete(request, "ratio")
}

func normalizeMiniMaxH3KIERatio(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "auto" || normalized == "adaptive" {
		return "auto"
	}
	return normalizeMiniMaxH3Ratio(value, "text")
}

func normalizeHailuoVideoResolution(value string) string {
	switch strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), " ", "")) {
	case "480", "480p", "512", "512p":
		return "512P"
	case "720", "720p", "768", "768p":
		return "768P"
	default:
		return value
	}
}

func normalizeSeedance25VideoResolution(value string) string {
	switch strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), " ", "")) {
	case "1080", "1080p", "2k", "4k":
		return "720p"
	default:
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "480":
			return "480p"
		case "720":
			return "720p"
		case "1080":
			return "1080p"
		default:
			return value
		}
	}
}

func normalizeKlingOmniResolution(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "4k":
		return "4k"
	case "pro", "1080", "1080p":
		return "1080p"
	default:
		return "720p"
	}
}

func normalizeMiniMaxH3Resolution(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "2k", "2048", "2048p", "4k", "2160", "2160p", "1080", "1080p", "high", "pro":
		return "2K"
	case "768", "768p", "768P", "720", "720p", "480", "480p", "low", "standard":
		return "768P"
	default:
		if strings.TrimSpace(value) == "" {
			return ""
		}
		return "768P"
	}
}

// MiniMax H3 accepts a closed ratio enum. The workbench exposes adaptive for
// reference inputs, while the provider calls that value auto. Keep this
// normalization at the provider boundary so legacy/direct callers cannot send
// arbitrary ratios such as "adaptive" or pixel dimensions upstream.
func normalizeMiniMaxH3Ratio(value, mode string) string {
	normalized := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(value, "×", "x")))
	switch normalized {
	case "auto", "adaptive":
		if strings.EqualFold(strings.TrimSpace(mode), "reference") || strings.EqualFold(strings.TrimSpace(mode), "first-frame") {
			return "auto"
		}
		return "16:9"
	case "21:9", "16:9", "4:3", "1:1", "3:4", "9:16":
		return normalized
	case "1280x720", "1920x1080":
		return "16:9"
	case "720x1280", "1080x1920":
		return "9:16"
	case "1024x1024", "1080x1080":
		return "1:1"
	default:
		if strings.EqualFold(strings.TrimSpace(mode), "reference") || strings.EqualFold(strings.TrimSpace(mode), "first-frame") {
			return "auto"
		}
		return "16:9"
	}
}

func applyBytedanceV1VideoRequest(request, metadata map[string]any, refs []string, size, resolution string) {
	model := strings.ToLower(strings.TrimSpace(util.Clean(request["model"])))
	if strings.Contains(model, "image-to-video") && len(refs) > 0 {
		setVideoProviderField(request, metadata, "image_url", refs[0])
		if len(refs) > 1 && strings.Contains(model, "v1-lite-image-to-video") {
			setVideoProviderField(request, metadata, "end_image_url", refs[1])
		}
	} else if size != "" {
		setVideoProviderField(request, metadata, "aspect_ratio", size)
	} else {
		delete(request, "image_url")
		delete(metadata, "image_url")
	}
	if resolution != "" {
		setVideoProviderField(request, metadata, "resolution", resolution)
	}
	if strings.Contains(model, "image-to-video") {
		delete(request, "size")
		delete(request, "aspect_ratio")
		delete(metadata, "aspect_ratio")
	}
	delete(request, "input_reference")
}

func applySeedanceVideoRequest(request, metadata, payload map[string]any, refs, referenceVideoURLs, referenceAudioURLs []string, referenceMode, size string) {
	name := strings.ToLower(strings.TrimSpace(util.Clean(request["model"])))
	isKIE := strings.Contains(name, "/")
	isSeedance15 := strings.Contains(name, "seedance-1.5") || strings.Contains(name, "seedance-1-5")
	isSeedance1 := isSeedance15 || strings.Contains(name, "seedance-1.0") || strings.Contains(name, "seedance-1-0")
	frameRefs := videoFrameAliases(payload)
	// APIMart only exposes multimodal reference arrays on Seedance 2.x. The
	// 1.x endpoints accept image roles, but reject reference video/audio lists.
	isSeedance2 := strings.Contains(name, "seedance-2") || strings.Contains(name, "seedance-2-") || strings.Contains(name, "seedance-2.")
	if isKIE {
		// KIE Seedance keeps first_frame_url/last_frame_url as independent
		// named slots. Do not also copy those same values into the ordinary
		// reference array when the compatibility layer selected them as refs.
		if len(frameRefs) > 0 && referenceMode != "reference" {
			refs = nil
		}
		// Seedance 1.5 uses input_urls; Seedance 2.x uses the multimodal
		// reference arrays for ordinary reference images.
		if len(refs) > 0 {
			if isSeedance15 {
				setVideoProviderField(request, metadata, "input_urls", refs)
			} else {
				setVideoProviderField(request, metadata, "reference_image_urls", refs)
			}
		}
		if isSeedance2 {
			copyVideoReference(request, metadata, "reference_video_urls", referenceVideoURLs)
			copyVideoReference(request, metadata, "reference_audio_urls", referenceAudioURLs)
		}
	} else {
		if !isAPIMartVideoPayload(payload) {
			// Bare model callers historically receive the compatibility envelope;
			// keep those aliases until the selected provider is known.
			if len(refs) > 0 {
				setVideoProviderField(request, metadata, "image_with_roles", buildSeedanceImageRoles(refs))
				setVideoProviderField(request, metadata, "reference_image_urls", refs)
			}
			if isSeedance2 {
				copyVideoReference(request, metadata, "video_urls", referenceVideoURLs)
				copyVideoReference(request, metadata, "audio_urls", referenceAudioURLs)
				copyVideoReference(request, metadata, "reference_video_urls", referenceVideoURLs)
				copyVideoReference(request, metadata, "reference_audio_urls", referenceAudioURLs)
			}
		} else {
			// APIMart reserves image_with_roles for explicit first/last frames.
			// Ordinary references remain image_urls and are removed later when
			// frames take precedence, matching the reference project.
			roleRefs := frameRefs
			if len(roleRefs) == 0 && (isSeedance1 || referenceMode != "reference") {
				roleRefs = refs
			}
			if len(roleRefs) > 0 {
				setVideoProviderField(request, metadata, "image_with_roles", buildSeedanceImageRoles(roleRefs))
				delete(request, "first_frame_url")
				delete(request, "last_frame_url")
			}
			if len(refs) > 0 && (len(frameRefs) > 0 || referenceMode == "reference") {
				setVideoProviderField(request, metadata, "image_urls", refs)
			}
			if isSeedance2 {
				copyVideoReference(request, metadata, "video_urls", referenceVideoURLs)
				copyVideoReference(request, metadata, "audio_urls", referenceAudioURLs)
				copyVideoReference(request, metadata, "reference_video_urls", referenceVideoURLs)
				copyVideoReference(request, metadata, "reference_audio_urls", referenceAudioURLs)
			}
		}
	}
	if size != "" {
		if isKIE {
			request["aspect_ratio"] = size
			metadata["aspect_ratio"] = size
			delete(request, "size")
		} else if isSeedance1 {
			// APIMart Seedance 1.0/1.5 calls the field aspect_ratio. Sending
			// the Seedance 2.x `size` field makes the provider silently ignore
			// the selected ratio (or reject strict schemas).
			request["aspect_ratio"] = size
			metadata["aspect_ratio"] = size
			delete(request, "size")
			delete(request, "ratio")
		} else {
			// APIMart names this field `size`; `ratio` is not a Seedance
			// parameter, but older unified relays still read `ratio`. Send both
			// aliases while keeping `size` as the provider-native value.
			request["size"] = size
			request["ratio"] = size
			metadata["ratio"] = size
		}
	}
	if resolution := util.Clean(payload["resolution"]); resolution != "" {
		normalized := resolution
		if isKIE && strings.HasPrefix(name, "bytedance/seedance-2-5") {
			normalized = normalizeSeedance25VideoResolution(resolution)
		}
		request["resolution"] = normalized
		metadata["resolution"] = normalized
	}
	if value, ok := payload["generate_audio"].(bool); ok {
		if isSeedance15 && !isKIE {
			// APIMart Seedance 1.5 names this control `audio`; Seedance 2.x
			// uses `generate_audio`.
			request["audio"] = value
			metadata["audio"] = value
		} else {
			if isSeedance15 || isSeedance2 {
				request["generate_audio"] = value
				metadata["generate_audio"] = value
			}
		}
	}
	if videoProviderSupportsWatermark(name) {
		if value, ok := payload["watermark"].(bool); ok {
			request["watermark"] = value
			metadata["watermark"] = value
		}
	}
	// The generic compatibility relay can express multimodal references as
	// content parts. KIE and APIMart already received their provider-native
	// reference arrays above, and both strict contracts reject this extra field.
	if referenceMode == "reference" && !isKIE && !isAPIMartVideoPayload(payload) && !(strings.Contains(name, "seedance-1.5") || strings.Contains(name, "seedance-1-5")) {
		content := make([]map[string]any, 0, len(refs)+len(referenceVideoURLs)+len(referenceAudioURLs))
		for _, value := range refs {
			content = append(content, map[string]any{"type": "image_url", "image_url": map[string]any{"url": value}, "role": "reference_image"})
		}
		for _, value := range referenceVideoURLs {
			content = append(content, map[string]any{"type": "video_url", "video_url": map[string]any{"url": value}, "role": "reference_video"})
		}
		for _, value := range referenceAudioURLs {
			content = append(content, map[string]any{"type": "audio_url", "audio_url": map[string]any{"url": value}, "role": "reference_audio"})
		}
		if len(content) > 0 {
			metadata["content"] = content
		}
	}
}

func buildSeedanceImageRoles(refs []string) []map[string]string {
	roles := make([]map[string]string, 0, len(refs))
	for index, value := range refs {
		role := "reference_image"
		if index == 0 {
			role = "first_frame"
		} else if index == 1 {
			role = "last_frame"
		}
		roles = append(roles, map[string]string{"url": value, "role": role})
	}
	return roles
}

func applyGenericVideoRequest(request, payload map[string]any) {
	if value, ok := payload["generate_audio"].(bool); ok {
		request["generate_audio"] = value
	}
}

// The reference workbench exposes watermark only for Seedance. Keep stale
// compatibility flags from leaking to providers without that control.
func videoProviderSupportsWatermark(model string) bool {
	return strings.HasPrefix(protocol.VideoModelProfile(model), "seedance-")
}

func copyVideoReference(request, metadata map[string]any, key string, values []string) {
	if len(values) == 0 {
		return
	}
	request[key] = values
	metadata[key] = values
}

func setVideoProviderField(request, metadata map[string]any, key string, value any) {
	request[key] = value
	metadata[key] = value
}

// normalizeKIEAspectRatio mirrors the reference project's KIE transport
// boundary. The workbench may store pixel dimensions, while KIE endpoints
// with an aspect field accept ratio enums.
func normalizeKIEAspectRatio(value string) string {
	normalized := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), " ", ""))
	switch normalized {
	case "", "auto", "adaptive":
		return normalized
	case "landscape", "landscape_16_9", "1280x720", "1920x1080", "1024x576", "720x405":
		return "16:9"
	case "portrait", "portrait_16_9", "720x1280", "1080x1920", "576x1024", "405x720":
		return "9:16"
	case "square", "square_hd", "1024x1024", "1080x1080", "960x960":
		return "1:1"
	case "landscape_4_3":
		return "4:3"
	case "portrait_4_3":
		return "3:4"
	}
	separator := ":"
	if strings.Contains(normalized, "x") {
		separator = "x"
	} else if strings.Contains(normalized, "*") {
		separator = "*"
	}
	parts := strings.Split(normalized, separator)
	if len(parts) == 2 {
		if width, widthErr := strconv.ParseFloat(parts[0], 64); widthErr == nil && width > 0 {
			if height, heightErr := strconv.ParseFloat(parts[1], 64); heightErr == nil && height > 0 {
				options := []struct {
					name, ratio string
					value       float64
				}{
					{"1:1", "1:1", 1}, {"16:9", "16:9", 16.0 / 9}, {"9:16", "9:16", 9.0 / 16},
					{"4:3", "4:3", 4.0 / 3}, {"3:4", "3:4", 3.0 / 4}, {"21:9", "21:9", 21.0 / 9},
				}
				target := width / height
				best := options[0]
				bestDiff := math.Abs(target-best.value) / best.value
				for _, option := range options[1:] {
					diff := math.Abs(target-option.value) / option.value
					if diff < bestDiff {
						best, bestDiff = option, diff
					}
				}
				if bestDiff <= 0.04 {
					return best.name
				}
				return strconv.FormatFloat(width, 'f', -1, 64) + ":" + strconv.FormatFloat(height, 'f', -1, 64)
			}
		}
	}
	return normalized
}

// applyKIEVideoDefaults is kept in lockstep with the reference project's
// applyKIEModelDefaults. These fields are part of the provider contract even
// when their UI toggles are left untouched.
func applyKIEVideoDefaults(request map[string]any, model string) {
	if !strings.Contains(model, "/") {
		return
	}
	setDefault := func(key string, value any) {
		if _, exists := request[key]; !exists {
			request[key] = value
		}
	}
	switch strings.ToLower(strings.TrimSpace(model)) {
	case "minimax-h3/text-to-video":
		setDefault("aspect_ratio", "16:9")
	case "kling-2.6/text-to-video", "kling-2.6/image-to-video":
		setDefault("sound", false)
	case "kling-2.6/motion-control", "kling-3.0/motion-control":
		setDefault("mode", "720p")
	case "bytedance/seedance-2", "bytedance/seedance-2-fast":
		setDefault("return_last_frame", false)
	case "wan/2-6-flash-image-to-video", "wan/2-6-flash-video-to-video":
		setDefault("audio", false)
		setDefault("multi_shots", false)
	case "topaz/image-upscale":
		setDefault("upscale_factor", "2")
	}
}

// applyAPIMartVideoDefaults mirrors the reference project's APIMart adapter
// defaults. These are provider behavior defaults, not UI preferences.
func applyAPIMartVideoDefaults(request map[string]any, model string) {
	name := strings.ToLower(strings.TrimSpace(model))
	if strings.Contains(name, "/") {
		return
	}
	setDefault := func(key string, value any) {
		if _, exists := request[key]; !exists {
			request[key] = value
		}
	}
	clampDuration := func(minimum, maximum int) {
		value, ok := request["duration"]
		if !ok {
			return
		}
		seconds := util.ToInt(value, 0)
		if seconds < minimum {
			seconds = minimum
		}
		if seconds > maximum {
			seconds = maximum
		}
		request["duration"] = seconds
	}
	switch {
	case strings.Contains(name, "veo3.1") || strings.Contains(name, "veo-3.1"):
		// APIMart Veo 3.1 is fixed at eight seconds by the reference request
		// builder, even when the generic panel retains another selected value.
		request["duration"] = 8
	case name == "doubao-seedance-2.5" || name == "doubao-seedance-2-5":
		resolution := strings.ToLower(strings.TrimSpace(util.Clean(request["resolution"])))
		if resolution == "1080p" || resolution == "1080" || resolution == "2k" || resolution == "4k" {
			request["resolution"] = "720p"
		}
		if util.ToInt(request["duration"], 0) != -1 {
			clampDuration(4, 30)
		}
	case name == "flux-3-video":
		resolution := strings.ToLower(strings.TrimSpace(util.Clean(request["resolution"])))
		if resolution == "360p" || resolution == "360" || resolution == "480p" || resolution == "480" {
			request["resolution"] = "720p"
		}
		clampDuration(5, 20)
	case name == "minimax-h3":
		resolution := strings.ToLower(strings.TrimSpace(util.Clean(request["resolution"])))
		if resolution == "480p" || resolution == "480" || resolution == "720p" || resolution == "720" || resolution == "768p" {
			request["resolution"] = "768P"
		} else {
			request["resolution"] = "2K"
		}
		clampDuration(4, 15)
	case strings.Contains(name, "wan2-5") || strings.Contains(name, "wan2.5"):
		setDefault("audio", true)
	case isAPIMartKlingMotionControlModel(name):
		delete(request, "keep_original_sound")
		delete(request, "watermark_info")
		setDefault("mode", "std")
		setDefault("character_orientation", "video")
	case strings.Contains(name, "motion-control"):
		setDefault("mode", "std")
		setDefault("character_orientation", "image")
		setDefault("keep_original_sound", "yes")
	}
}

func isAPIMartKlingMotionControlModel(model string) bool {
	name := strings.NewReplacer("_", "-", ".", "-", "/", "-").Replace(strings.ToLower(strings.TrimSpace(model)))
	return name == "kling-v2-6-motion-control" || name == "kling-v3-motion-control"
}

// normalizeKIEDurationRequest follows kieModelInputConfig.durationKind from
// the reference project. Strict KIE schemas distinguish JSON strings from
// numbers, so field presence alone is not sufficient contract coverage.
func normalizeKIEDurationRequest(request map[string]any, model string, seconds int) {
	name := strings.ToLower(strings.TrimSpace(model))
	if kieVideoDurationKind(name) == "" {
		return
	}
	if _, exists := request["duration"]; !exists {
		delete(request, "seconds")
		return
	}
	kind := kieVideoDurationKind(name)
	switch kind {
	case "none":
		delete(request, "duration")
		delete(request, "seconds")
	case "string":
		request["duration"] = strconv.Itoa(seconds)
		delete(request, "seconds")
	case "number":
		request["duration"] = seconds
		delete(request, "seconds")
	default:
		delete(request, "seconds")
	}
}

// normalizeKIEVideoDurationBounds mirrors the min/max values declared by the
// reference project's KIE model configuration. Direct relay callers can
// bypass the web normalizer, so bounds must be enforced at this boundary too.
func normalizeKIEVideoDurationBounds(request map[string]any, model string) {
	name := strings.ToLower(strings.TrimSpace(model))
	minimum, maximum := 0, 0
	switch {
	case name == "bytedance/seedance-2-5":
		minimum, maximum = 4, 30
	case name == "grok-imagine/image-to-video", name == "grok-imagine/text-to-video":
		minimum, maximum = 6, 30
	case strings.HasPrefix(name, "minimax-h3/"):
		minimum, maximum = 4, 15
	case strings.HasPrefix(name, "kling-3.0-omni/"):
		minimum, maximum = 3, 15
	default:
		return
	}
	value, ok := request["duration"]
	if !ok {
		return
	}
	duration, err := strconv.Atoi(strings.TrimSpace(util.Clean(value)))
	if err != nil {
		return
	}
	if duration < minimum {
		duration = minimum
	}
	if maximum > 0 && duration > maximum {
		duration = maximum
	}
	if kieVideoDurationKind(name) == "string" {
		request["duration"] = strconv.Itoa(duration)
	} else {
		request["duration"] = duration
	}
}

// normalizeKIEVideoAspectRequest converts pixel dimensions and legacy aliases
// into the exact aspect field declared by each KIE endpoint.
func normalizeKIEVideoAspectRequest(request map[string]any, model string) {
	name := strings.ToLower(strings.TrimSpace(model))
	field := kieVideoAspectField(name)
	if field == "" {
		for _, key := range []string{"size", "ratio", "aspect_ratio"} {
			delete(request, key)
		}
		return
	}
	value := firstNonEmpty(util.Clean(request[field]), util.Clean(request["size"]), util.Clean(request["ratio"]), util.Clean(request["aspect_ratio"]))
	if value == "" {
		return
	}
	value = normalizeKIEAspectRatio(value)
	for _, key := range []string{"size", "ratio", "aspect_ratio"} {
		if key != field {
			delete(request, key)
		}
	}
	request[field] = value
}

func kieVideoAspectField(model string) string {
	switch {
	case model == "wan/2-7-text-to-video":
		return "ratio"
	case model == "minimax-h3/image-to-video", strings.HasPrefix(model, "hailuo/"), strings.HasPrefix(model, "bytedance/v1-") && strings.Contains(model, "image-to-video"),
		model == "kling-2.6/image-to-video", model == "kling/v3-turbo-image-to-video", strings.Contains(model, "motion-control"),
		model == "happyhorse/image-to-video", model == "happyhorse/video-edit", model == "happyhorse-1-1/image-to-video",
		strings.HasPrefix(model, "wan/2-2-") && !strings.Contains(model, "text-to-video"), strings.HasPrefix(model, "wan/2-5-image-to-video"),
		strings.HasPrefix(model, "wan/2-6-") && !strings.Contains(model, "text-to-video"), model == "wan/2-6-text-to-video", model == "wan/2-7-image-to-video",
		strings.HasPrefix(model, "kling/ai-avatar-") || model == "infinitalk/from-audio" || model == "topaz/video-upscale":
		return ""
	case strings.HasPrefix(model, "kling-3.0-omni/"), strings.HasPrefix(model, "grok-imagine/"), strings.HasPrefix(model, "grok-imagine-video-"):
		return "aspect_ratio"
	default:
		// KIE models with a configured aspect field use aspect_ratio unless
		// explicitly listed above (including Seedance, HappyHorse reference,
		// Wan text-to-video, and Kling text-to-video endpoints).
		if strings.Contains(model, "/") || model == "gemini-omni-video" {
			return "aspect_ratio"
		}
		return ""
	}
}

func kieVideoDurationKind(model string) string {
	switch {
	case model == "kling-2.6/motion-control", model == "kling-3.0/motion-control",
		strings.HasPrefix(model, "kling/ai-avatar-"), strings.HasPrefix(model, "wan/2-2-"),
		model == "infinitalk/from-audio", model == "topaz/video-upscale", model == "happyhorse/video-edit":
		return "none"
	case strings.HasPrefix(model, "bytedance/v1-"), model == "gemini-omni-video",
		model == "grok-imagine/image-to-video", model == "grok-imagine/text-to-video",
		strings.HasPrefix(model, "hailuo/"), strings.HasPrefix(model, "kling-2.6/"), model == "kling-3.0/video",
		strings.HasPrefix(model, "kling/v3-turbo-"), strings.HasPrefix(model, "kling/v2-1-"),
		strings.HasPrefix(model, "kling/v2-5-"), strings.HasPrefix(model, "wan/2-5-"),
		strings.HasPrefix(model, "wan/2-6-"):
		return "string"
	case strings.HasPrefix(model, "bytedance/seedance-"), strings.HasPrefix(model, "minimax-h3/"),
		strings.HasPrefix(model, "happyhorse/"), strings.HasPrefix(model, "happyhorse-1-1/"),
		strings.HasPrefix(model, "kling-3.0-omni/"),
		strings.HasPrefix(model, "wan/2-7-"), strings.HasPrefix(model, "grok-imagine-video-1-5"):
		return "number"
	default:
		return ""
	}
}

// A few KIE endpoints intentionally use bare model IDs (for example
// gemini-omni-video and grok-imagine-video-1.5) instead of slash-qualified
// IDs. They still require the same strict cleanup as the regular KIE models.
func isKIEVideoModelName(model string) bool {
	name := strings.ToLower(strings.TrimSpace(model))
	return strings.Contains(name, "/") || kieVideoDurationKind(name) != ""
}
