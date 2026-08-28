package httpapi

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
)

type kieVideoEndpointContract struct {
	aspect, image, video, audio string
	duration, resolution        bool
}

var kieVideoEndpointContracts = map[string]kieVideoEndpointContract{
	"bytedance/seedance-1.5-pro":           {aspect: "aspect_ratio", duration: true, resolution: true, image: "input_urls"},
	"bytedance/seedance-2":                 {aspect: "aspect_ratio", duration: true, resolution: true, image: "reference_image_urls", video: "reference_video_urls", audio: "reference_audio_urls"},
	"bytedance/seedance-2-fast":            {aspect: "aspect_ratio", duration: true, resolution: true, image: "reference_image_urls", video: "reference_video_urls", audio: "reference_audio_urls"},
	"bytedance/seedance-2-mini":            {aspect: "aspect_ratio", duration: true, resolution: true, image: "reference_image_urls", video: "reference_video_urls", audio: "reference_audio_urls"},
	"bytedance/seedance-2-5":               {aspect: "aspect_ratio", duration: true, resolution: true, image: "reference_image_urls", video: "reference_video_urls", audio: "reference_audio_urls"},
	"bytedance/v1-lite-image-to-video":     {duration: true, resolution: true, image: "image_url"},
	"bytedance/v1-lite-text-to-video":      {aspect: "aspect_ratio", duration: true, resolution: true},
	"bytedance/v1-pro-fast-image-to-video": {duration: true, resolution: true, image: "image_url"},
	"bytedance/v1-pro-image-to-video":      {duration: true, resolution: true, image: "image_url"},
	"bytedance/v1-pro-text-to-video":       {aspect: "aspect_ratio", duration: true, resolution: true},
	"gemini-omni-video":                    {aspect: "aspect_ratio", duration: true, resolution: true, image: "image_urls", video: "video_list", audio: "audio_ids"},
	"grok-imagine/image-to-video":          {aspect: "aspect_ratio", duration: true, resolution: true, image: "image_urls"},
	"grok-imagine/text-to-video":           {aspect: "aspect_ratio", duration: true, resolution: true},
	"grok-imagine-video-1-5-preview":       {aspect: "aspect_ratio", duration: true, resolution: true, image: "image_urls"},
	"happyhorse/image-to-video":            {duration: true, resolution: true, image: "image_urls"},
	"happyhorse/reference-to-video":        {aspect: "aspect_ratio", duration: true, resolution: true, image: "reference_image"},
	"happyhorse/text-to-video":             {aspect: "aspect_ratio", duration: true, resolution: true},
	"happyhorse/video-edit":                {resolution: true, image: "reference_image", video: "video_url"},
	"happyhorse-1-1/text-to-video":         {aspect: "aspect_ratio", duration: true, resolution: true},
	"happyhorse-1-1/image-to-video":        {duration: true, resolution: true, image: "image_urls"},
	"happyhorse-1-1/reference-to-video":    {aspect: "aspect_ratio", duration: true, resolution: true, image: "reference_image"},
	"minimax-h3/text-to-video":             {aspect: "aspect_ratio", duration: true, resolution: true},
	"minimax-h3/image-to-video":            {duration: true, resolution: true, image: "first_frame_url"},
	"minimax-h3/reference-to-video":        {aspect: "aspect_ratio", duration: true, resolution: true, image: "reference_image_urls", video: "reference_video_urls", audio: "reference_audio_urls"},
	"hailuo/02-image-to-video-standard":    {duration: true, resolution: true, image: "image_url"},
	"hailuo/02-image-to-video-pro":         {duration: true, resolution: true, image: "image_url"},
	"hailuo/2-3-image-to-video-pro":        {duration: true, resolution: true, image: "image_url"},
	"hailuo/2-3-image-to-video-standard":   {duration: true, resolution: true, image: "image_url"},
	"hailuo/02-text-to-video-standard":     {duration: true},
	"hailuo/02-text-to-video-pro":          {duration: true},
	"kling-2.6/image-to-video":             {duration: true, image: "image_urls"},
	"kling-2.6/text-to-video":              {aspect: "aspect_ratio", duration: true},
	"kling-2.6/motion-control":             {image: "input_urls", video: "video_urls"},
	"kling-3.0/motion-control":             {image: "input_urls", video: "video_urls"},
	"kling-3.0/video":                      {aspect: "aspect_ratio", duration: true, image: "image_urls"},
	"kling-3.0-omni/text-to-video":         {aspect: "aspect_ratio", duration: true, resolution: true},
	"kling-3.0-omni/image-to-video":        {aspect: "aspect_ratio", duration: true, resolution: true, image: "image_urls"},
	"kling-3.0-omni/reference-to-video":    {aspect: "aspect_ratio", duration: true, resolution: true, image: "image_urls", video: "video_urls"},
	"kling-3.0-omni/transformation":        {aspect: "aspect_ratio", duration: true, resolution: true, image: "image_urls", video: "video_urls"},
	"kling/v3-turbo-text-to-video":         {aspect: "aspect_ratio", duration: true, resolution: true},
	"kling/v3-turbo-image-to-video":        {duration: true, resolution: true, image: "image_urls"},
	"kling/ai-avatar-standard":             {image: "image_url", audio: "audio_url"},
	"kling/ai-avatar-pro":                  {image: "image_url", audio: "audio_url"},
	"kling/v2-1-master-image-to-video":     {duration: true, image: "image_url"},
	"kling/v2-1-master-text-to-video":      {aspect: "aspect_ratio", duration: true},
	"kling/v2-1-pro":                       {duration: true, image: "image_url"},
	"kling/v2-1-standard":                  {duration: true, image: "image_url"},
	"kling/v2-5-turbo-image-to-video-pro":  {duration: true, image: "image_url"},
	"kling/v2-5-turbo-text-to-video-pro":   {aspect: "aspect_ratio", duration: true},
	"wan/2-2-a14b-image-to-video-turbo":    {resolution: true, image: "image_url"},
	"wan/2-2-a14b-speech-to-video-turbo":   {resolution: true, image: "image_url", audio: "audio_url"},
	"wan/2-2-a14b-text-to-video-turbo":     {aspect: "aspect_ratio", resolution: true},
	"wan/2-2-animate-move":                 {resolution: true, image: "image_url", video: "video_url"},
	"wan/2-2-animate-replace":              {resolution: true, image: "image_url", video: "video_url"},
	"wan/2-5-image-to-video":               {duration: true, resolution: true, image: "image_url"},
	"wan/2-5-text-to-video":                {aspect: "aspect_ratio", duration: true, resolution: true},
	"wan/2-6-flash-image-to-video":         {duration: true, resolution: true, image: "image_urls"},
	"wan/2-6-flash-video-to-video":         {duration: true, resolution: true, video: "video_urls"},
	"wan/2-6-image-to-video":               {duration: true, resolution: true, image: "image_urls"},
	"wan/2-6-text-to-video":                {duration: true, resolution: true},
	"wan/2-6-video-to-video":               {duration: true, resolution: true, video: "video_urls"},
	"wan/2-7-image-to-video":               {duration: true, resolution: true, image: "first_frame_url", video: "first_clip_url", audio: "driving_audio_url"},
	"wan/2-7-r2v":                          {aspect: "aspect_ratio", duration: true, resolution: true, image: "reference_image", video: "reference_video", audio: "reference_voice"},
	"wan/2-7-text-to-video":                {aspect: "ratio", duration: true, resolution: true, audio: "audio_url"},
	"wan/2-7-videoedit":                    {aspect: "aspect_ratio", duration: true, resolution: true, image: "reference_image", video: "video_url"},
	"topaz/video-upscale":                  {video: "video_url"},
	"infinitalk/from-audio":                {resolution: true, image: "image_url", audio: "audio_url"},
}

func videoPayloadField(payload map[string]any, key string) (any, bool) {
	if value, ok := payload[key]; ok {
		return value, true
	}
	metadata, _ := payload["metadata"].(map[string]any)
	if metadata == nil {
		return nil, false
	}
	value, ok := metadata[key]
	return value, ok
}

func TestKnownAPIMartBareVideoModelsMatchReferenceFamilies(t *testing.T) {
	for _, model := range []string{
		"doubao-seedance-2-0-260128", "sora-2", "sora-2-pro", "veo3.1-official",
		"minimax-h3", "minimax-hailuo-2-3", "skyreels-v4", "kling-v2-6", "kling-v3",
		"kling-v3-omni", "happyhorse", "happyhorse-1-1", "gemini-omni-flash-preview", "omni-flash-ext",
		"wan2-7-r2v", "viduq3-pro", "grok-imagine", "pixverse-v6", "flux-3-video",
	} {
		if !isKnownAPIMartVideoModel(model) {
			t.Errorf("APIMart bare model %q was not recognized", model)
		}
	}
	for _, model := range []string{
		"gemini-omni-video", "grok-imagine-video", "grok-imagine-video-1-5-preview", "grok-imagine-video-1.5",
		"kling-3.0/video", "wan/2-7-r2v", "bytedance/seedance-2",
	} {
		if isKnownAPIMartVideoModel(model) {
			t.Errorf("KIE model %q was misclassified as APIMart", model)
		}
	}
}

func assertVideoPayloadField(t *testing.T, payload map[string]any, field string, expected bool) {
	t.Helper()
	_, found := videoPayloadField(payload, field)
	if found != expected {
		t.Fatalf("field %q presence = %v, want %v: %#v", field, found, expected, payload)
	}
}

func assertAnyVideoPayloadField(t *testing.T, payload map[string]any, fields []string, expected bool) {
	t.Helper()
	found := false
	for _, field := range fields {
		if _, ok := videoPayloadField(payload, field); ok {
			found = true
			break
		}
	}
	if found != expected {
		t.Fatalf("field group %v presence = %v, want %v: %#v", fields, found, expected, payload)
	}
}

func TestAllKIEVideoEndpointControlContracts(t *testing.T) {
	for model, contract := range kieVideoEndpointContracts {
		t.Run(model, func(t *testing.T) {
			input := map[string]any{
				"model": model, "prompt": "animate", "size": "16:9", "seconds": 7, "resolution": "720p",
			}
			if contract.image != "" {
				input["reference_image_urls"] = []string{"https://cdn.example.com/reference.png"}
			}
			if contract.video != "" {
				input["reference_video_urls"] = []string{"https://cdn.example.com/reference.mp4"}
			}
			if contract.audio != "" {
				if contract.audio == "audio_ids" {
					input["audio_ids"] = []string{"audio_example"}
				} else {
					input["reference_audio_urls"] = []string{"https://cdn.example.com/reference.mp3"}
				}
			}
			got := officialVideoRequestPayload(input)
			if contract.aspect != "" {
				assertVideoPayloadField(t, got, contract.aspect, true)
				for _, field := range []string{"size", "ratio", "image_size"} {
					if field != contract.aspect {
						assertVideoPayloadField(t, got, field, false)
					}
				}
			} else {
				for _, field := range []string{"size", "ratio", "aspect_ratio"} {
					assertVideoPayloadField(t, got, field, false)
				}
			}
			if contract.aspect != "ratio" {
				assertVideoPayloadField(t, got, "ratio", false)
			}
			assertVideoPayloadField(t, got, "seconds", false)
			for _, field := range []struct {
				name   string
				field  string
				wanted bool
			}{
				{name: "image", field: contract.image, wanted: contract.image != ""},
				{name: "video", field: contract.video, wanted: contract.video != ""},
				{name: "audio", field: contract.audio, wanted: contract.audio != ""},
			} {
				if field.field != "" {
					assertVideoPayloadField(t, got, field.field, field.wanted)
				}
			}
			if !contract.duration {
				assertVideoPayloadField(t, got, "seconds", false)
				assertVideoPayloadField(t, got, "duration", false)
			}
			assertVideoPayloadField(t, got, "resolution", contract.resolution)
			if !contract.resolution {
				if _, ok := got["resolution"]; ok {
					t.Fatalf("model %s leaked unsupported resolution: %#v", model, got)
				}
			}
			if contract.image == "" {
				assertAnyVideoPayloadField(t, got, []string{"image", "images", "image_url", "image_urls", "input_url", "input_urls", "input_reference", "first_frame_url", "last_frame_url", "reference_image", "reference_image_urls"}, false)
			}
			if contract.video == "" {
				assertAnyVideoPayloadField(t, got, []string{"video", "videos", "video_url", "video_urls", "input_video_urls", "first_clip_url", "reference_video", "reference_video_urls"}, false)
			}
			if contract.audio == "" {
				assertAnyVideoPayloadField(t, got, []string{"audio_url", "audio_urls", "input_audio_urls", "driving_audio_url", "reference_voice", "reference_audio_urls", "audio_ids"}, false)
			}
		})
	}
}

func TestKIEVideoValueTypesAndProviderDefaultsMatchReferenceProject(t *testing.T) {
	image := "https://cdn.example.com/frame.png"
	tests := []struct {
		name  string
		input map[string]any
		want  map[string]any
	}{
		{
			name:  "Seedance number duration and last frame default",
			input: map[string]any{"model": "bytedance/seedance-2", "seconds": 8, "size": "1280x720"},
			want:  map[string]any{"duration": 8, "aspect_ratio": "16:9", "return_last_frame": false},
		},
		{
			name:  "Kling string duration and sound default",
			input: map[string]any{"model": "kling-2.6/text-to-video", "seconds": 10, "size": "1280x720"},
			want:  map[string]any{"duration": "10", "aspect_ratio": "16:9", "sound": false},
		},
		{
			name:  "Kling universal string duration",
			input: map[string]any{"model": "kling-3.0/video", "seconds": 6, "size": "16:9"},
			want:  map[string]any{"duration": "6"},
		},
		{
			name:  "Gemini Omni string duration",
			input: map[string]any{"model": "gemini-omni-video", "seconds": 8, "size": "16:9"},
			want:  map[string]any{"duration": "8"},
		},
		{
			name:  "MiniMax H3 number duration",
			input: map[string]any{"model": "minimax-h3/text-to-video", "seconds": 6, "size": "16:9"},
			want:  map[string]any{"duration": 6, "aspect_ratio": "16:9"},
		},
		{
			name:  "Wan 2.6 string duration and flash defaults",
			input: map[string]any{"model": "wan/2-6-flash-image-to-video", "seconds": 10, "reference_image_urls": []string{image}},
			want:  map[string]any{"duration": "10", "audio": false, "multi_shots": false},
		},
		{
			name:  "Wan 2.7 number duration",
			input: map[string]any{"model": "wan/2-7-image-to-video", "seconds": 10, "reference_image_urls": []string{image}},
			want:  map[string]any{"duration": 10},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			test.input["prompt"] = "animate"
			got := officialVideoRequestPayload(test.input)
			for key, want := range test.want {
				value, ok := videoPayloadField(got, key)
				if !ok || !reflect.DeepEqual(value, want) {
					t.Fatalf("%s = %#v (%T), want %#v (%T); payload=%#v", key, value, value, want, want, got)
				}
			}
			if _, exists := got["seconds"]; exists {
				t.Fatalf("KIE request leaked compatibility seconds: %#v", got)
			}
		})
	}
}

func TestKIESeedancePreservesSmartDuration(t *testing.T) {
	for _, model := range []string{"bytedance/seedance-2", "bytedance/seedance-2-5"} {
		t.Run(model, func(t *testing.T) {
			got := officialVideoRequestPayload(map[string]any{
				"model":   model,
				"prompt":  "animate",
				"seconds": -1,
			})
			if duration, ok := videoPayloadField(got, "duration"); !ok || duration != -1 {
				t.Fatalf("duration = %#v (%T), want -1; payload=%#v", duration, duration, got)
			}
		})
	}
}

func TestKIEVideoResolutionValuesMatchReferenceProject(t *testing.T) {
	tests := []struct {
		name  string
		input map[string]any
		want  any
	}{
		{
			name:  "Seedance 2.5 clamps unsupported high resolution",
			input: map[string]any{"model": "bytedance/seedance-2-5", "seconds": 8, "resolution": "1080p"},
			want:  "720p",
		},
		{
			name:  "Hailuo maps 480 to 512P",
			input: map[string]any{"model": "hailuo/02-image-to-video-standard", "seconds": 6, "resolution": "480p", "reference_image_urls": []string{"https://cdn.example.com/frame.png"}},
			want:  "512P",
		},
		{
			name:  "Hailuo maps 720 to 768P",
			input: map[string]any{"model": "hailuo/02-image-to-video-standard", "seconds": 6, "resolution": "720p", "reference_image_urls": []string{"https://cdn.example.com/frame.png"}},
			want:  "768P",
		},
		{
			name:  "Kling Omni maps pro to 1080p",
			input: map[string]any{"model": "kling-3.0-omni/text-to-video", "seconds": 6, "resolution": "pro"},
			want:  "1080p",
		},
		{
			name:  "MiniMax H3 maps 720 to 768P",
			input: map[string]any{"model": "minimax-h3/text-to-video", "seconds": 6, "resolution": "720p"},
			want:  "768P",
		},
		{
			name:  "MiniMax H3 maps 1080 to 2K",
			input: map[string]any{"model": "minimax-h3/text-to-video", "seconds": 6, "resolution": "1080p"},
			want:  "2K",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := officialVideoRequestPayload(test.input)
			if value, ok := videoPayloadField(got, "resolution"); !ok || value != test.want {
				t.Fatalf("resolution = %#v (%T), want %#v (%T); payload=%#v", value, value, test.want, test.want, got)
			}
		})
	}
}

func TestKIEMiniMaxH3UsesReferenceAspectField(t *testing.T) {
	text := officialVideoRequestPayload(map[string]any{
		"model": "minimax-h3/text-to-video", "prompt": "animate", "size": "adaptive", "seconds": 6,
	})
	if text["aspect_ratio"] != "16:9" {
		t.Fatalf("MiniMax H3 text aspect_ratio = %#v, payload=%#v", text["aspect_ratio"], text)
	}
	if _, ok := text["ratio"]; ok {
		t.Fatalf("MiniMax H3 text leaked ratio: %#v", text)
	}
	reference := officialVideoRequestPayload(map[string]any{
		"model": "minimax-h3/reference-to-video", "prompt": "animate", "size": "adaptive", "seconds": 6,
		"reference_image_urls": []string{"https://cdn.example.com/reference.png"},
	})
	if reference["aspect_ratio"] != "auto" {
		t.Fatalf("MiniMax H3 reference aspect_ratio = %#v, payload=%#v", reference["aspect_ratio"], reference)
	}
	if _, ok := reference["ratio"]; ok {
		t.Fatalf("MiniMax H3 reference leaked ratio: %#v", reference)
	}
	image := officialVideoRequestPayload(map[string]any{
		"model": "minimax-h3/image-to-video", "prompt": "animate", "size": "16:9", "seconds": 6,
		"reference_image_urls": []string{"https://cdn.example.com/frame.png"},
	})
	if _, ok := image["aspect_ratio"]; ok {
		t.Fatalf("MiniMax H3 image mode leaked aspect_ratio: %#v", image)
	}
}

func TestAPIMartVideoDefaultsMatchReferenceProject(t *testing.T) {
	tests := []struct {
		model string
		input map[string]any
		want  map[string]any
	}{
		{"doubao-seedance-2-5", map[string]any{"seconds": 40, "resolution": "1080p"}, map[string]any{"duration": 30, "resolution": "720p"}},
		{"flux-3-video", map[string]any{"seconds": 2, "resolution": "480p"}, map[string]any{"duration": 5, "resolution": "720p"}},
		{"minimax-h3", map[string]any{"seconds": 2, "resolution": "720p"}, map[string]any{"duration": 4, "resolution": "768P"}},
		{"veo3.1", map[string]any{"seconds": 4, "resolution": "720p"}, map[string]any{"duration": 8}},
		{"veo3.1-official", map[string]any{"seconds": 6, "resolution": "720p"}, map[string]any{"duration": 8}},
		{"wan2-5-image-to-video", map[string]any{"seconds": 5}, map[string]any{"audio": true}},
		{"kling-v2-6-motion-control", map[string]any{}, map[string]any{"mode": "std", "character_orientation": "video"}},
		{"kling-v3-motion-control", map[string]any{}, map[string]any{"mode": "std", "character_orientation": "video"}},
	}
	for _, test := range tests {
		t.Run(test.model, func(t *testing.T) {
			test.input["model"] = test.model
			test.input["prompt"] = "animate"
			got := officialVideoRequestPayload(test.input)
			for key, want := range test.want {
				if value, ok := videoPayloadField(got, key); !ok || !reflect.DeepEqual(value, want) {
					t.Fatalf("%s = %#v, want %#v; payload=%#v", key, value, want, got)
				}
			}
		})
	}
}

func TestAPIMartMotionControlDefaultsMatchReferenceProject(t *testing.T) {
	t.Run("generic motion control keeps source sound", func(t *testing.T) {
		request := map[string]any{}
		applyAPIMartVideoDefaults(request, "vendor-motion-control")
		want := map[string]any{
			"mode":                  "std",
			"character_orientation": "image",
			"keep_original_sound":   "yes",
		}
		if !reflect.DeepEqual(request, want) {
			t.Fatalf("generic motion defaults = %#v, want %#v", request, want)
		}
	})

	for _, model := range []string{"kling-v2-6-motion-control", "kling-v3-motion-control"} {
		t.Run(model+" removes unsupported fields", func(t *testing.T) {
			request := map[string]any{
				"keep_original_sound": "yes",
				"watermark_info":      map[string]any{"enabled": true},
			}
			applyAPIMartVideoDefaults(request, model)
			want := map[string]any{
				"mode":                  "std",
				"character_orientation": "video",
			}
			if !reflect.DeepEqual(request, want) {
				t.Fatalf("%s defaults = %#v, want %#v", model, request, want)
			}
		})
	}
}

func TestAPIMartGeminiOmniFlashOmitsCreatorDuration(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "gemini-omni-flash-preview", "provider": "apimart", "prompt": "animate", "seconds": 6,
	})
	if _, ok := got["duration"]; ok {
		t.Fatalf("Gemini Omni Flash leaked creator duration: %#v", got)
	}
	if _, ok := got["seconds"]; ok {
		t.Fatalf("Gemini Omni Flash leaked compatibility seconds: %#v", got)
	}
}

func TestVideoGenerateAudioMetadataUsesReferenceProjectFieldNames(t *testing.T) {
	seedance15 := officialVideoRequestPayload(map[string]any{
		"model":                "doubao-seedance-1-5-pro",
		"prompt":               "animate",
		"seconds":              6,
		"size":                 "16:9",
		"video_generate_audio": true,
		"provider":             "apimart",
	})
	if got, ok := videoPayloadField(seedance15, "audio"); !ok || got != true {
		t.Fatalf("Seedance 1.5 audio = %#v (present=%v), want true", got, ok)
	}
	if _, ok := videoPayloadField(seedance15, "generate_audio"); ok {
		t.Fatalf("Seedance 1.5 leaked generate_audio: %#v", seedance15)
	}

	seedance2 := officialVideoRequestPayload(map[string]any{
		"model":                "doubao-seedance-2-5",
		"prompt":               "animate",
		"seconds":              6,
		"size":                 "16:9",
		"video_generate_audio": true,
		"provider":             "apimart",
	})
	if got, ok := videoPayloadField(seedance2, "generate_audio"); !ok || got != true {
		t.Fatalf("Seedance 2.x generate_audio = %#v (present=%v), want true", got, ok)
	}
}

func TestAPIMartVideoRequestDropsCompatibilityAliases(t *testing.T) {
	tests := []struct {
		name  string
		input map[string]any
		check func(*testing.T, map[string]any)
	}{
		{
			name: "sora uses aspect ratio quality and duration",
			input: map[string]any{
				"model": "sora-2", "provider": "apimart", "prompt": "animate",
				"size": "16:9", "seconds": 8, "resolution": "1080p",
			},
			check: func(t *testing.T, got map[string]any) {
				if got["aspect_ratio"] != "16:9" || got["duration"] != 8 || got["quality"] != "720p" {
					t.Fatalf("APIMart Sora fields = %#v", got)
				}
				if _, ok := got["size"]; ok {
					t.Fatalf("APIMart Sora leaked size: %#v", got)
				}
				if _, ok := got["seconds"]; ok {
					t.Fatalf("APIMart Sora leaked seconds: %#v", got)
				}
			},
		},
		{
			name: "minimax h3 converts adaptive ratio",
			input: map[string]any{
				"model": "minimax-h3", "provider": "apimart", "prompt": "animate",
				"size": "adaptive", "seconds": 6,
			},
			check: func(t *testing.T, got map[string]any) {
				if got["aspect_ratio"] != "16:9" {
					t.Fatalf("APIMart MiniMax H3 ratio = %#v, payload=%#v", got["aspect_ratio"], got)
				}
				if got["duration"] != 6 {
					t.Fatalf("APIMart MiniMax H3 duration = %#v, payload=%#v", got["duration"], got)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			test.check(t, officialVideoRequestPayload(test.input))
		})
	}
}

func TestAPIMartVideoRequestDoesNotSendCompatibilityMetadata(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model":                "skyreels-v4",
		"provider":             "apimart",
		"prompt":               "animate",
		"size":                 "16:9",
		"seconds":              5,
		"resolution":           "720p",
		"reference_mode":       "reference",
		"reference_image_urls": []string{"https://cdn.example.com/reference.png"},
	})
	if _, ok := got["metadata"]; ok {
		t.Fatalf("APIMart request retained compatibility metadata: %#v", got)
	}
	if _, ok := got["ref_images"]; !ok {
		t.Fatalf("APIMart request lost flattened native references: %#v", got)
	}
}

func TestAllKIEVideoEndpointCapabilitiesMatchContracts(t *testing.T) {
	for model, contract := range kieVideoEndpointContracts {
		t.Run(model, func(t *testing.T) {
			capability := protocol.VideoCapability(model)
			if (len(capability.Sizes) > 0) != (contract.aspect != "") {
				t.Fatalf("model %s size capability does not match aspect contract %q: %+v", model, contract.aspect, capability)
			}
			if (len(capability.Resolutions) > 0) != contract.resolution {
				t.Fatalf("model %s resolution capability does not match contract: %+v", model, capability)
			}
			if (capability.FirstFrameImageLimit > 0 || capability.References.Image > 0) != (contract.image != "") {
				t.Fatalf("model %s image capability does not match field %q: %+v", model, contract.image, capability)
			}
			if (capability.References.Video > 0) != (contract.video != "") {
				t.Fatalf("model %s video capability does not match field %q: %+v", model, contract.video, capability)
			}
			// Gemini Omni's audio_ids are provider-issued IDs. The shared UI
			// intentionally does not expose public-URL audio references, so its
			// capability limit remains zero even though the native field is
			// supported for direct callers.
			if contract.audio != "audio_ids" && (capability.References.Audio > 0) != (contract.audio != "") {
				t.Fatalf("model %s audio capability does not match field %q: %+v", model, contract.audio, capability)
			}
		})
	}
}

func TestAPIMartWan26AudioToggleUsesExactReferenceWhitelist(t *testing.T) {
	for _, test := range []struct {
		model string
		want  bool
	}{
		{model: "wan2-6", want: true},
		{model: "wan2-6-i2v-flash", want: true},
		{model: "wan2-6-flash-image-to-video", want: false},
		{model: "wan2-6-flash-video-to-video", want: false},
		{model: "wan2-6-image-to-video", want: false},
		{model: "wan2-6-video-to-video", want: false},
	} {
		t.Run(test.model, func(t *testing.T) {
			got := officialVideoRequestPayload(map[string]any{
				"model": test.model, "provider": "apimart", "prompt": "animate",
				"seconds": 10, "generate_audio": true,
			})
			_, hasAudio := got["audio"]
			if hasAudio != test.want {
				t.Fatalf("APIMart %s audio field present=%v, payload=%#v", test.model, hasAudio, got)
			}
		})
	}
}

func TestAPIMartViduAudioToggleUsesExactReferenceWhitelist(t *testing.T) {
	for _, test := range []struct {
		model string
		want  bool
	}{
		{model: "viduq3", want: false},
		{model: "viduq3-mix", want: false},
		{model: "viduq3-pro", want: true},
		{model: "vidu-q3-pro", want: true},
		{model: "viduq3-turbo", want: true},
	} {
		t.Run(test.model, func(t *testing.T) {
			got := officialVideoRequestPayload(map[string]any{
				"model": test.model, "provider": "apimart", "prompt": "animate",
				"seconds": 5, "generate_audio": true,
			})
			_, hasAudio := got["audio"]
			if hasAudio != test.want {
				t.Fatalf("APIMart %s audio field present=%v, payload=%#v", test.model, hasAudio, got)
			}
		})
	}
}

func TestAPIMartHappyHorse11NamedFirstFrameWinsOverOtherImages(t *testing.T) {
	first := "https://cdn.example.com/first.png"
	last := "https://cdn.example.com/last.png"
	got := officialVideoRequestPayload(map[string]any{
		"model": "happyhorse-1-1", "provider": "apimart", "prompt": "animate",
		"first_frame_url": first, "last_frame_url": last,
	})
	if got["first_frame_image"] != first {
		t.Fatalf("HappyHorse 1.1 first_frame_image = %#v, payload=%#v", got["first_frame_image"], got)
	}
	if _, ok := got["image_urls"]; ok {
		t.Fatalf("HappyHorse 1.1 retained image_urls alongside first_frame_image: %#v", got)
	}
	for _, key := range []string{"first_frame_url", "last_frame_url"} {
		if _, ok := got[key]; ok {
			t.Fatalf("HappyHorse 1.1 leaked compatibility field %q: %#v", key, got)
		}
	}
}

func TestAPIMartVeoAndGeminiVeoUseDifferentReferenceContracts(t *testing.T) {
	images := []string{"https://cdn.example.com/first.png", "https://cdn.example.com/last.png"}

	apimart := officialVideoRequestPayload(map[string]any{
		"model": "veo3.1", "prompt": "animate", "seconds": 8,
		"size": "16:9", "resolution": "1080p", "reference_mode": "reference",
		"reference_image_urls": images,
	})
	if refs, ok := apimart["image_urls"].([]string); !ok || !reflect.DeepEqual(refs, images) {
		t.Fatalf("APIMart Veo image_urls = %#v, payload=%#v", apimart["image_urls"], apimart)
	}
	if apimart["aspect_ratio"] != "16:9" || apimart["resolution"] != "1080p" || apimart["duration"] != 8 {
		t.Fatalf("APIMart Veo controls were not flattened: %#v", apimart)
	}
	metadata, _ := apimart["metadata"].(map[string]any)
	for _, key := range []string{"firstFrame", "lastFrame", "referenceImages", "aspectRatio", "durationSeconds"} {
		if _, ok := metadata[key]; ok {
			t.Fatalf("APIMart Veo leaked Gemini metadata field %q: %#v", key, apimart)
		}
	}
	for _, key := range []string{"seconds", "size", "reference_image_urls"} {
		if _, ok := apimart[key]; ok {
			t.Fatalf("APIMart Veo leaked compatibility field %q: %#v", key, apimart)
		}
	}

	gemini := officialVideoRequestPayload(map[string]any{
		"model": "veo-3.1-generate-preview", "provider": "gemini", "prompt": "animate", "seconds": 8,
		"size": "16:9", "resolution": "1080p", "reference_mode": "reference",
		"reference_image_urls": images,
	})
	geminiMetadata, _ := gemini["metadata"].(map[string]any)
	if refs, ok := geminiMetadata["referenceImages"].([]string); !ok || !reflect.DeepEqual(refs, images) {
		t.Fatalf("Gemini Veo referenceImages = %#v, payload=%#v", geminiMetadata["referenceImages"], gemini)
	}
	if _, ok := gemini["image_urls"]; ok {
		t.Fatalf("Gemini Veo leaked APIMart image_urls: %#v", gemini)
	}
}

func TestAPIMartSpecialReferencePayloadShapesMatchReferenceProject(t *testing.T) {
	image1 := "https://cdn.example.com/first.png"
	image2 := "https://cdn.example.com/second.png"
	video := "https://cdn.example.com/source.mp4"
	audio := "https://cdn.example.com/voice.mp3"

	tests := []struct {
		name  string
		input map[string]any
		check func(*testing.T, map[string]any)
	}{
		{
			name: "SkyReels nested references",
			input: map[string]any{"model": "skyreels-v4", "reference_mode": "reference",
				"reference_image_urls": []string{image1, image2}, "reference_video_urls": []string{video}, "reference_audio_urls": []string{audio}},
			check: func(t *testing.T, got map[string]any) {
				wantImages := []map[string]any{{"tag": "@image1", "type": "image", "image_urls": []string{image1, image2}, "audio_url": audio}}
				wantVideos := []map[string]string{{"tag": "@video1", "type": "reference", "video_url": video}}
				if !reflect.DeepEqual(got["ref_images"], wantImages) || !reflect.DeepEqual(got["ref_videos"], wantVideos) {
					t.Fatalf("SkyReels references = %#v / %#v, payload=%#v", got["ref_images"], got["ref_videos"], got)
				}
			},
		},
		{
			name: "Kling Omni video list",
			input: map[string]any{"model": "kling-v3-omni", "reference_mode": "reference",
				"reference_image_urls": []string{image1}, "reference_video_urls": []string{video}, "generate_audio": true},
			check: func(t *testing.T, got map[string]any) {
				want := []map[string]string{{"video_url": video, "refer_type": "base", "keep_original_sound": "no"}}
				if !reflect.DeepEqual(got["video_list"], want) || !reflect.DeepEqual(got["image_urls"], []string{image1}) {
					t.Fatalf("Kling Omni references = %#v / %#v, payload=%#v", got["video_list"], got["image_urls"], got)
				}
				if _, ok := got["audio"]; ok {
					t.Fatalf("Kling Omni retained audio alongside video_list: %#v", got)
				}
			},
		},
		{
			name: "PixVerse ordinary references",
			input: map[string]any{"model": "pixverse-v6", "reference_mode": "reference",
				"reference_image_urls": []string{image1, image2}},
			check: func(t *testing.T, got map[string]any) {
				if !reflect.DeepEqual(got["img_references"], []string{image1, image2}) {
					t.Fatalf("PixVerse img_references = %#v, payload=%#v", got["img_references"], got)
				}
			},
		},
		{
			name: "Wan video edit",
			input: map[string]any{"model": "wan2-7-videoedit", "reference_mode": "reference",
				"reference_image_urls": []string{image1}, "reference_video_urls": []string{video}, "reference_audio_urls": []string{audio}},
			check: func(t *testing.T, got map[string]any) {
				if !reflect.DeepEqual(got["image_urls"], []string{image1}) || !reflect.DeepEqual(got["video_urls"], []string{video}) {
					t.Fatalf("Wan videoedit references = %#v / %#v, payload=%#v", got["image_urls"], got["video_urls"], got)
				}
				if _, ok := got["audio_url"]; ok {
					t.Fatalf("Wan videoedit leaked unsupported audio_url: %#v", got)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			test.input["provider"] = "apimart"
			test.input["prompt"] = "animate"
			test.input["seconds"] = 5
			test.input["size"] = "16:9"
			test.input["resolution"] = "720p"
			got := officialVideoRequestPayload(test.input)
			test.check(t, got)
			for _, key := range []string{"seconds", "reference_image_urls", "reference_video_urls", "reference_audio_urls", "first_frame_url", "last_frame_url"} {
				if _, ok := got[key]; ok {
					t.Fatalf("APIMart payload leaked compatibility field %q: %#v", key, got)
				}
			}
		})
	}
}

func TestAllKIEVideoEndpointReferenceContracts(t *testing.T) {
	const image = "https://cdn.example.com/reference.png"
	const video = "https://cdn.example.com/reference.mp4"
	const audio = "https://cdn.example.com/reference.mp3"
	for model, contract := range kieVideoEndpointContracts {
		t.Run(model, func(t *testing.T) {
			input := map[string]any{
				"model": model, "prompt": "animate", "seconds": 7, "resolution": "720p",
				"reference_mode": "reference",
			}
			if contract.image != "" {
				input["reference_image_urls"] = []string{image}
			}
			if contract.video != "" {
				input["reference_video_urls"] = []string{video}
			}
			if contract.audio != "" {
				if contract.audio == "audio_ids" {
					input["audio_ids"] = []string{"audio_example"}
				} else {
					input["reference_audio_urls"] = []string{audio}
				}
			}
			got := officialVideoRequestPayload(input)
			for _, field := range []string{contract.image, contract.video, contract.audio} {
				if field != "" {
					assertVideoPayloadField(t, got, field, true)
				}
			}
		})
	}
}

func TestAllKIEVideoEndpointReferencesDoNotLeak(t *testing.T) {
	const image = "https://cdn.example.com/reference.png"
	const video = "https://cdn.example.com/reference.mp4"
	const audio = "https://cdn.example.com/reference.mp3"
	aliases := map[string][]string{
		"image": {"input_reference", "image", "images", "image_url", "image_urls", "input_urls", "first_frame_url", "last_frame_url", "end_image_url", "tail_image_url", "reference_image", "reference_image_urls"},
		"video": {"video_url", "video_urls", "video_list", "first_clip_url", "reference_video", "reference_video_urls"},
		"audio": {"audio_url", "audio_urls", "audio_ids", "driving_audio_url", "reference_voice", "reference_audio_urls"},
	}
	for model, contract := range kieVideoEndpointContracts {
		t.Run(model, func(t *testing.T) {
			input := map[string]any{
				"model": model, "prompt": "animate", "reference_mode": "reference",
				"reference_image_urls": []string{image},
				"reference_video_urls": []string{video},
				"reference_audio_urls": []string{audio},
			}
			if contract.audio == "audio_ids" {
				delete(input, "reference_audio_urls")
				input["audio_ids"] = []string{"audio_example"}
			}
			got := officialVideoRequestPayload(input)
			for kind, fields := range aliases {
				expected := map[string]string{"image": contract.image, "video": contract.video, "audio": contract.audio}[kind]
				for _, field := range fields {
					_, found := videoPayloadField(got, field)
					if field == expected {
						if !found {
							t.Fatalf("model %s lost %s reference field %q: %#v", model, kind, field, got)
						}
					} else if found {
						t.Fatalf("model %s leaked unsupported %s reference field %q: %#v", model, kind, field, got)
					}
				}
			}
		})
	}
}

func TestAPIMartExactModelControlContracts(t *testing.T) {
	tests := []struct {
		model                 string
		aspect, duration, res bool
		imageDropsAspect      bool
	}{
		{"doubao-seedance-2-0-260128", true, true, true, false},
		{"doubao-seedance-1-5-pro", true, true, true, false},
		{"sora-2", true, true, true, true},
		{"sora-2-pro", true, true, true, true},
		{"veo3.1-official", true, true, true, false},
		{"minimax-h3", true, true, true, false},
		{"minimax-hailuo-2-3", false, true, true, false},
		{"skyreels-v4", true, true, true, false},
		{"kling-3-0-turbo", true, true, true, true},
		{"happyhorse-1-1", true, true, true, false},
		{"gemini-omni-flash-preview", true, false, true, false},
		{"omni-flash-ext", true, true, true, false},
		{"wan2-7-r2v", true, true, true, false},
		{"wan2-7-videoedit", true, true, true, false},
		{"wan2-7-i2v", true, true, true, false},
		{"wan2-6", true, true, true, false},
		{"wan2-6-i2v-flash", false, true, true, true},
		{"kling-v2-6-motion-control", false, false, false, false},
		{"kling-v3-motion-control", false, false, false, false},
		{"kling-v2-6", true, true, false, false},
		{"kling-v3", true, true, false, false},
		{"kling-v3-omni", true, true, false, false},
		{"kling-video-o1", true, true, false, false},
		{"viduq3", true, true, true, false},
		{"viduq3-mix", true, true, true, false},
		{"grok-imagine-video-1.5", true, true, true, false},
		{"pixverse-v6", true, true, true, false},
		{"flux-3-video", true, true, true, false},
	}
	for _, test := range tests {
		t.Run(test.model, func(t *testing.T) {
			base := map[string]any{"model": test.model, "provider": "apimart", "prompt": "animate", "size": "1280x720", "seconds": 7, "resolution": "720p"}
			got := officialVideoRequestPayload(base)
			assertAnyVideoPayloadField(t, got, []string{"size", "ratio", "aspect_ratio"}, test.aspect)
			assertAnyVideoPayloadField(t, got, []string{"seconds", "duration"}, test.duration)
			assertAnyVideoPayloadField(t, got, []string{"resolution", "quality"}, test.res)
			if test.imageDropsAspect {
				base["reference_image_urls"] = []string{"https://cdn.example.com/reference.png"}
				withImage := officialVideoRequestPayload(base)
				assertAnyVideoPayloadField(t, withImage, []string{"size", "ratio", "aspect_ratio"}, false)
			}
		})
	}
}

func TestAPIMartVideoResolutionCapsMatchReferenceProject(t *testing.T) {
	tests := []struct {
		model, want string
	}{
		{model: "sora-2", want: "720p"},
		{model: "sora-2-pro", want: "1080p"},
		{model: "gemini-omni-flash-preview", want: "720p"},
	}
	for _, test := range tests {
		t.Run(test.model, func(t *testing.T) {
			got := officialVideoRequestPayload(map[string]any{
				"model": test.model, "provider": "apimart", "prompt": "animate",
				"size": "16:9", "seconds": 8, "resolution": "1080p",
			})
			field := "resolution"
			if strings.HasPrefix(test.model, "sora-2") {
				field = "quality"
			}
			if got[field] != test.want {
				t.Fatalf("%s %s = %#v, want %q; payload=%#v", test.model, field, got[field], test.want, got)
			}
		})
	}
}

func TestWan27NativeImageRequestKeepsSize(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model":                "wan2.7-i2v-plus",
		"prompt":               "animate",
		"size":                 "16:9",
		"seconds":              10,
		"resolution":           "1080p",
		"reference_image_urls": []string{"https://cdn.example.com/reference.png"},
	})
	if value, ok := got["size"]; !ok || value != "16:9" {
		t.Fatalf("Wan 2.7 native image request lost size: %#v", got)
	}
}

func TestKIEVideoEndpointReferenceFieldMatrix(t *testing.T) {
	image1 := "https://cdn.example.com/first.png"
	image2 := "https://cdn.example.com/last.png"
	video := "https://cdn.example.com/source.mp4"
	audio := "https://cdn.example.com/voice.mp3"

	tests := []struct {
		name   string
		model  string
		input  map[string]any
		fields []string
	}{
		{
			name:   "Bytedance v1 lite named frames",
			model:  "bytedance/v1-lite-image-to-video",
			input:  map[string]any{"reference_image_urls": []string{image1, image2}},
			fields: []string{"image_url", "end_image_url"},
		},
		{
			name:   "Seedance multimodal references",
			model:  "bytedance/seedance-2",
			input:  map[string]any{"reference_mode": "reference", "reference_image_urls": []string{image1}, "reference_video_urls": []string{video}, "reference_audio_urls": []string{audio}},
			fields: []string{"reference_image_urls", "reference_video_urls", "reference_audio_urls"},
		},
		{
			name:   "Gemini Omni video list",
			model:  "gemini-omni-video",
			input:  map[string]any{"reference_video_urls": []string{video}},
			fields: []string{"video_list"},
		},
		{
			name:   "Kling motion control",
			model:  "kling-2.6/motion-control",
			input:  map[string]any{"reference_mode": "reference", "reference_image_urls": []string{image1}, "reference_video_urls": []string{video}},
			fields: []string{"input_urls", "video_urls"},
		},
		{
			name:   "Kling universal video",
			model:  "kling-3.0/video",
			input:  map[string]any{"size": "16:9", "resolution": "1080p", "video_mode": "pro"},
			fields: []string{"aspect_ratio", "mode"},
		},
		{
			name:   "Wan 2.7 image video audio",
			model:  "wan/2-7-image-to-video",
			input:  map[string]any{"size": "16:9", "reference_image_urls": []string{image1, image2}, "reference_video_urls": []string{video}, "reference_audio_urls": []string{audio}},
			fields: []string{"first_frame_url", "last_frame_url", "first_clip_url", "driving_audio_url"},
		},
		{
			name:   "Wan 2.7 R2V",
			model:  "wan/2-7-r2v",
			input:  map[string]any{"size": "16:9", "reference_mode": "reference", "reference_image_urls": []string{image1}, "reference_video_urls": []string{video}, "reference_audio_urls": []string{audio}},
			fields: []string{"reference_image", "reference_video", "reference_voice"},
		},
		{
			name:   "Wan video edit",
			model:  "wan/2-7-videoedit",
			input:  map[string]any{"size": "16:9", "reference_mode": "reference", "reference_video_urls": []string{video}},
			fields: []string{"video_url", "aspect_ratio"},
		},
		{
			name:   "Flux 3 image and video references",
			model:  "flux-3-video",
			input:  map[string]any{"reference_mode": "reference", "reference_image_urls": []string{image1}, "reference_video_urls": []string{video}},
			fields: []string{"image_urls", "video_url"},
		},
		{
			name:   "Topaz video input",
			model:  "topaz/video-upscale",
			input:  map[string]any{"reference_mode": "reference", "reference_video_urls": []string{video}},
			fields: []string{"video_url"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			test.input["model"] = test.model
			test.input["prompt"] = "animate"
			got := officialVideoRequestPayload(test.input)
			for _, field := range test.fields {
				if _, ok := videoPayloadField(got, field); !ok {
					t.Fatalf("model %s lost provider field %q: %#v", test.model, field, got)
				}
			}
		})
	}
}

func TestKIEVideoEndpointDoesNotLeakUnsupportedSharedControls(t *testing.T) {
	tests := []struct {
		name             string
		model            string
		input            map[string]any
		forbiddenRequest []string
		requiredRequest  []string
	}{
		{
			name:             "Kling turbo image has no size",
			model:            "kling/v3-turbo-image-to-video",
			input:            map[string]any{"size": "1280x720", "resolution": "720p", "reference_image_urls": []string{"https://cdn.example.com/frame.png"}},
			forbiddenRequest: []string{"size"},
		},
		{
			name:             "Wan 2.2 image has no duration",
			model:            "wan/2-2-a14b-image-to-video-turbo",
			input:            map[string]any{"seconds": 5, "reference_image_urls": []string{"https://cdn.example.com/frame.png"}},
			forbiddenRequest: []string{"seconds", "duration"},
		},
		{
			name:             "Kling universal has no standalone resolution",
			model:            "kling-3.0/video",
			input:            map[string]any{"size": "16:9", "resolution": "1080p", "video_mode": "pro"},
			forbiddenRequest: []string{"resolution"},
		},
		{
			name:             "KIE Kling motion has provider mode default",
			model:            "kling-3.0/motion-control",
			input:            map[string]any{"resolution": "1080p", "reference_image_urls": []string{"https://cdn.example.com/frame.png"}, "reference_video_urls": []string{"https://cdn.example.com/motion.mp4"}},
			forbiddenRequest: []string{"resolution"},
			requiredRequest:  []string{"mode"},
		},
		{
			name:             "APIMart Sora uses native aspect and quality fields",
			model:            "sora-2",
			input:            map[string]any{"size": "1280x720", "resolution": "720p", "seconds": 8},
			forbiddenRequest: []string{"size", "resolution", "seconds"},
			requiredRequest:  []string{"aspect_ratio", "quality", "duration"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			test.input["model"] = test.model
			test.input["prompt"] = "animate"
			got := officialVideoRequestPayload(test.input)
			for _, field := range test.forbiddenRequest {
				if _, ok := got[field]; ok {
					t.Fatalf("model %s leaked unsupported request field %q: %#v", test.model, field, got)
				}
			}
			for _, field := range test.requiredRequest {
				if _, ok := got[field]; !ok {
					t.Fatalf("model %s lost compatibility request field %q: %#v", test.model, field, got)
				}
			}
		})
	}
}

func TestKIEKlingAdvancedControlsUseReferenceFieldNames(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling-3.0/video", "prompt": "animate", "size": "16:9", "seconds": 6,
		"video_mode": "pro", "multi_shot": true, "shot_type": "customize",
		"multi_prompt": []any{map[string]any{"prompt": "shot", "duration": 3}},
		"element_list": []any{map[string]any{"name": "hero", "references": []any{map[string]any{"kind": "image", "url": "https://cdn.example.com/hero.png"}}}},
	})
	if got["multi_shots"] != true {
		t.Fatalf("Kling V3 multi_shots = %#v", got["multi_shots"])
	}
	if _, ok := got["multi_prompt"]; !ok {
		t.Fatalf("Kling V3 lost multi_prompt: %#v", got)
	}
	if _, ok := got["kling_elements"]; !ok {
		t.Fatalf("Kling V3 lost kling_elements: %#v", got)
	}
	for _, field := range []string{"multi_shot", "shot_type", "element_list", "negative_prompt"} {
		if _, ok := got[field]; ok {
			t.Fatalf("Kling V3 leaked compatibility field %q: %#v", field, got)
		}
	}
}

func TestKIEKlingAdvancedControlsNormalizeReferenceValues(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling-3.0/video", "prompt": "animate", "resolution": "4k",
		"multi_shot": true,
		"multi_prompt": []any{
			map[string]any{"prompt": "first", "duration": 99},
			map[string]any{"prompt": "", "duration": 2},
		},
		"element_list": []any{map[string]any{
			"name":       "hero",
			"references": []any{map[string]any{"kind": "image", "url": "https://cdn.example.com/hero.png"}, map[string]any{"kind": "audio", "url": "https://cdn.example.com/voice.mp3"}},
		}},
	})
	if got["mode"] != "4K" {
		t.Fatalf("Kling V3 mode = %#v, want 4K", got["mode"])
	}
	prompts, ok := got["multi_prompt"].([]map[string]any)
	if !ok || len(prompts) != 2 || prompts[0]["duration"] != 12 || prompts[1]["prompt"] != "" || prompts[1]["duration"] != 2 {
		t.Fatalf("normalized Kling prompts = %#v", got["multi_prompt"])
	}
	elements, ok := got["kling_elements"].([]map[string]any)
	if !ok || len(elements) != 1 || len(elements[0]["element_input_urls"].([]string)) != 1 || len(elements[0]["element_input_audio_urls"].([]string)) != 1 {
		t.Fatalf("normalized Kling elements = %#v", got["kling_elements"])
	}
}

func TestKIEKlingAdvancedControlsKeepDefaultEmptyMultiPrompt(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling-3.0/video", "prompt": "animate",
		"multi_shot": true, "shot_type": "customize",
		"multi_prompt": []any{map[string]any{"prompt": "", "duration": 1}},
	})
	prompts, ok := got["multi_prompt"].([]map[string]any)
	if !ok || len(prompts) != 1 || prompts[0]["prompt"] != "" || prompts[0]["duration"] != 1 {
		t.Fatalf("Kling V3 default multi_prompt = %#v", got["multi_prompt"])
	}
}

func TestKIEKlingUniversalKeepsAllMultiPrompts(t *testing.T) {
	prompts := make([]any, 8)
	for index := range prompts {
		prompts[index] = map[string]any{"prompt": fmt.Sprintf("shot-%d", index+1), "duration": 2}
	}
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling-3.0/video", "prompt": "animate",
		"multi_shot": true, "multi_prompt": prompts,
	})
	normalized, ok := got["multi_prompt"].([]map[string]any)
	if !ok || len(normalized) != len(prompts) {
		t.Fatalf("Kling V3 multi_prompt = %#v, want %d entries", got["multi_prompt"], len(prompts))
	}
}

func TestKIEKlingOmniControlsUseReferenceFieldNames(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling-3.0-omni/reference-to-video", "prompt": "animate", "size": "16:9", "seconds": 6,
		"multi_shot": true, "shot_type": "customize",
		"multi_prompt": []any{map[string]any{"prompt": "shot", "duration": 3}},
		"element_list": []any{map[string]any{"name": "hero", "references": []any{map[string]any{"kind": "image", "url": "https://cdn.example.com/hero.png"}}}},
	})
	if got["customize_multi_shots"] != true {
		t.Fatalf("Kling Omni customize_multi_shots = %#v", got["customize_multi_shots"])
	}
	if _, ok := got["prefer_multi_shots"]; ok {
		t.Fatalf("Kling Omni reference endpoint leaked prefer_multi_shots: %#v", got)
	}
	if _, ok := got["multi_prompt"]; !ok {
		t.Fatalf("Kling Omni lost multi_prompt: %#v", got)
	}
	if _, ok := got["elements"]; !ok {
		t.Fatalf("Kling Omni lost elements: %#v", got)
	}
}

func TestKIEKlingOmniModeControlsResolution(t *testing.T) {
	for _, test := range []struct {
		mode string
		want string
	}{
		{mode: "std", want: "720p"},
		{mode: "pro", want: "1080p"},
		{mode: "4k", want: "4k"},
	} {
		got := officialVideoRequestPayload(map[string]any{
			"model": "kling-3.0-omni/text-to-video", "prompt": "animate", "seconds": 6,
			"resolution": "720p", "video_mode": test.mode,
		})
		if got["resolution"] != test.want {
			t.Fatalf("mode %q resolution = %#v, want %q; payload=%#v", test.mode, got["resolution"], test.want, got)
		}
	}
}

func TestKIEKlingOmniControlsClearVideoOnlyReferenceState(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling-3.0-omni/reference-to-video", "prompt": "animate", "size": "16:9", "seconds": 6,
		"reference_video_urls":  []string{"https://cdn.example.com/source.mp4"},
		"customize_multi_shots": true,
		"multi_prompt":          []any{map[string]any{"prompt": "stale", "duration": 2}},
	})
	if got["aspect_ratio"] != "auto" {
		t.Fatalf("video-only Omni aspect_ratio = %#v", got["aspect_ratio"])
	}
	if _, ok := got["duration"]; ok {
		t.Fatalf("video-only Omni leaked duration: %#v", got)
	}
	if got["customize_multi_shots"] != false {
		t.Fatalf("video-only Omni customize_multi_shots = %#v", got["customize_multi_shots"])
	}
	if _, ok := got["multi_prompt"]; ok {
		t.Fatalf("video-only Omni leaked multi_prompt: %#v", got)
	}
}

func TestAPIMartMotionControlMapsQualityToMode(t *testing.T) {
	for _, test := range []struct {
		model string
		want  string
	}{
		{model: "kling-v2-6-motion-control", want: "pro"},
		{model: "kling-v3-motion-control", want: "std"},
	} {
		t.Run(test.model, func(t *testing.T) {
			payload := officialVideoRequestPayload(map[string]any{
				"model": test.model, "prompt": "animate", "resolution": map[string]string{"pro": "1080p", "std": "720p"}[test.want],
			})
			mode, ok := videoPayloadField(payload, "mode")
			if !ok || mode != test.want {
				t.Fatalf("motion quality was not mapped to mode %q: %#v", test.want, payload)
			}
			assertVideoPayloadField(t, payload, "resolution", false)
		})
	}
}

func TestAPIMartMotionControlPreservesCharacterOrientation(t *testing.T) {
	for _, model := range []string{"kling-v2-6-motion-control", "kling-v3-motion-control"} {
		for _, orientation := range []string{"image", "video"} {
			t.Run(model+"/"+orientation, func(t *testing.T) {
				payload := officialVideoRequestPayload(map[string]any{
					"model": model, "prompt": "animate", "character_orientation": orientation,
				})
				if got, ok := videoPayloadField(payload, "character_orientation"); !ok || got != orientation {
					t.Fatalf("character_orientation = %#v, want %q; payload=%#v", got, orientation, payload)
				}
				assertVideoPayloadField(t, payload, "resolution", false)
			})
		}
	}
}

func TestKIEMotionControlPreservesCharacterOrientation(t *testing.T) {
	for _, model := range []string{"kling-2.6/motion-control", "kling-3.0/motion-control"} {
		for _, orientation := range []string{"image", "video"} {
			t.Run(model+"/"+orientation, func(t *testing.T) {
				payload := officialVideoRequestPayload(map[string]any{
					"model": model, "prompt": "animate", "character_orientation": orientation,
				})
				if got, ok := videoPayloadField(payload, "character_orientation"); !ok || got != orientation {
					t.Fatalf("character_orientation = %#v, want %q; payload=%#v", got, orientation, payload)
				}
			})
		}
	}
}

func TestAPIMartSeedanceOnePointFiveUsesAspectRatioAndImageRoles(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model":                "doubao-seedance-1-5-pro",
		"prompt":               "animate",
		"size":                 "9:16",
		"seconds":              6,
		"resolution":           "720p",
		"reference_image_urls": []string{"https://cdn.example.com/first.png"},
		"reference_video_urls": []string{"https://cdn.example.com/unsupported.mp4"},
		"reference_audio_urls": []string{"https://cdn.example.com/unsupported.mp3"},
	})
	if got["aspect_ratio"] != "9:16" {
		t.Fatalf("Seedance 1.5 aspect_ratio = %#v, payload=%#v", got["aspect_ratio"], got)
	}
	if _, ok := got["size"]; ok {
		t.Fatalf("Seedance 1.5 leaked size: %#v", got)
	}
	if _, ok := got["ratio"]; ok {
		t.Fatalf("Seedance 1.5 leaked compatibility ratio: %#v", got)
	}
	if _, ok := got["video_urls"]; ok {
		t.Fatalf("Seedance 1.5 leaked unsupported video references: %#v", got)
	}
	if _, ok := got["audio_urls"]; ok {
		t.Fatalf("Seedance 1.5 leaked unsupported audio references: %#v", got)
	}
	if roles, ok := got["image_with_roles"].([]map[string]string); !ok || len(roles) != 1 || roles[0]["role"] != "first_frame" {
		t.Fatalf("Seedance 1.5 image roles = %#v, payload=%#v", got["image_with_roles"], got)
	}
}

func TestAPIMartWan27R2VUsesRoleReferences(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "wan2-7-r2v", "prompt": "animate", "size": "16:9", "seconds": 5,
		"reference_mode":       "reference",
		"reference_image_urls": []string{"https://cdn.example.com/character.png"},
		"reference_video_urls": []string{"https://cdn.example.com/motion.mp4"},
		"reference_audio_urls": []string{"https://cdn.example.com/voice.mp3"},
	})
	roles, ok := got["image_with_roles"].([]map[string]string)
	if !ok || len(roles) != 1 || roles[0]["role"] != "reference_image" || roles[0]["reference_voice"] != "https://cdn.example.com/voice.mp3" {
		t.Fatalf("Wan 2.7 R2V roles = %#v, payload=%#v", got["image_with_roles"], got)
	}
	if _, ok := got["reference_voice"]; ok {
		t.Fatalf("Wan 2.7 R2V leaked root reference_voice: %#v", got)
	}
	if got["video_urls"] == nil {
		t.Fatalf("Wan 2.7 R2V lost video_urls: %#v", got)
	}
}

func TestAPIMartWan26TextIncludesNativeAspectRatio(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "wan2.6-t2v", "prompt": "animate", "size": "16:9", "seconds": 5,
	})
	if got["aspect_ratio"] != "16:9" {
		t.Fatalf("Wan 2.6 text aspect_ratio = %#v, payload=%#v", got["aspect_ratio"], got)
	}
}

func TestAPIMartGrokUsesSizeAndQuality(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "grok-imagine", "prompt": "animate", "size": "16:9", "seconds": 6, "resolution": "1080p",
	})
	if got["size"] != "16:9" || got["quality"] != "1080p" {
		t.Fatalf("APIMart Grok native controls = %#v", got)
	}
	for _, field := range []string{"aspect_ratio", "resolution"} {
		if _, ok := got[field]; ok {
			t.Fatalf("APIMart Grok leaked KIE field %q: %#v", field, got)
		}
	}
}

func TestAPIMartKlingV3UsesNativeAdvancedFields(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling-v3", "provider": "apimart", "prompt": "animate", "size": "16:9", "seconds": 6,
		"resolution": "1080p", "multi_shot": true, "shot_type": "customize",
		"multi_prompt": []any{map[string]any{"prompt": "shot", "duration": 99}},
		"element_list": []any{map[string]any{
			"name": "hero", "description": "main", "element_input_urls": []any{
				"https://cdn.example.com/1.png", "https://cdn.example.com/2.png",
			},
		}},
	})
	if got["multi_shot"] != true || got["shot_type"] != "customize" {
		t.Fatalf("APIMart Kling V3 advanced controls = %#v", got)
	}
	prompts, ok := got["multi_prompt"].([]map[string]any)
	if !ok || len(prompts) != 1 || prompts[0]["index"] != 1 || prompts[0]["duration"] != 15 {
		t.Fatalf("APIMart Kling V3 multi_prompt = %#v", got["multi_prompt"])
	}
	elements, ok := got["element_list"].([]map[string]any)
	if !ok || len(elements) != 1 {
		t.Fatalf("APIMart Kling V3 element_list = %#v", got["element_list"])
	}
}

func TestAPIMartKlingV3ElementsDoNotDependOnMultiShot(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling-v3", "provider": "apimart", "prompt": "animate", "seconds": 6,
		"element_list": []any{map[string]any{
			"name": "hero", "references": []any{
				map[string]any{"kind": "image", "url": "https://cdn.example.com/hero.png"},
			},
		}},
	})
	elements, ok := got["element_list"].([]map[string]any)
	if !ok || len(elements) != 1 {
		t.Fatalf("APIMart Kling V3 independent element_list = %#v", got["element_list"])
	}
	urls, ok := elements[0]["element_input_urls"].([]string)
	if !ok || len(urls) != 1 || urls[0] != "https://cdn.example.com/hero.png" {
		t.Fatalf("APIMart Kling V3 element URLs = %#v", elements[0]["element_input_urls"])
	}
}

func TestAPIMartKlingV3CustomMultiShotGetsReferenceDefaultPrompt(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "kling-v3", "provider": "apimart", "prompt": "animate", "seconds": 6,
		"multi_shot": true, "shot_type": "customize", "multi_prompt": []any{},
	})
	prompts, ok := got["multi_prompt"].([]map[string]any)
	if !ok || len(prompts) != 1 || prompts[0]["index"] != 1 || prompts[0]["duration"] != 1 {
		t.Fatalf("APIMart Kling V3 default multi_prompt = %#v", got["multi_prompt"])
	}
}

func TestAPIMartMiniMaxH3UsesMultimodalArrays(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "minimax-h3", "provider": "apimart", "prompt": "animate", "size": "adaptive", "seconds": 6, "resolution": "768P",
		"reference_image_urls": []string{"https://cdn.example.com/reference.png"},
		"reference_video_urls": []string{"https://cdn.example.com/reference.mp4"},
		"reference_audio_urls": []string{"https://cdn.example.com/reference.mp3"},
	})
	if got["aspect_ratio"] != "auto" {
		t.Fatalf("APIMart MiniMax H3 aspect_ratio = %#v, payload=%#v", got["aspect_ratio"], got)
	}
	if got["generation_mode"] != "reference-to-video" || got["resolution"] != "768P" {
		t.Fatalf("APIMart MiniMax H3 enums = %#v", got)
	}
	for _, field := range []string{"image_urls", "video_urls", "audio_urls"} {
		if _, ok := got[field]; !ok {
			t.Fatalf("APIMart MiniMax H3 lost %s: %#v", field, got)
		}
	}
	if _, ok := got["size"]; ok {
		t.Fatalf("APIMart MiniMax H3 leaked compatibility size: %#v", got)
	}
}

func TestBareAPIMartMiniMaxH3UsesMultimodalArraysWithoutProviderHint(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "minimax-h3", "prompt": "animate", "size": "adaptive", "seconds": 6, "resolution": "768P",
		"reference_image_urls": []string{"https://cdn.example.com/reference.png"},
		"reference_video_urls": []string{"https://cdn.example.com/reference.mp4"},
		"reference_audio_urls": []string{"https://cdn.example.com/reference.mp3"},
	})
	if got["aspect_ratio"] != "auto" {
		t.Fatalf("bare APIMart MiniMax H3 aspect_ratio = %#v, payload=%#v", got["aspect_ratio"], got)
	}
	if got["generation_mode"] != "reference-to-video" || got["resolution"] != "768P" {
		t.Fatalf("bare APIMart MiniMax H3 enums = %#v", got)
	}
	for _, field := range []string{"image_urls", "video_urls", "audio_urls"} {
		if _, ok := got[field]; !ok {
			t.Fatalf("bare APIMart MiniMax H3 lost %s: %#v", field, got)
		}
	}
}

func TestAPIMartMiniMaxH3ImageModeUsesNamedFrames(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "minimax-h3", "provider": "apimart", "prompt": "animate", "size": "16:9", "seconds": 6, "resolution": "768P",
		"reference_mode":       "first-frame",
		"reference_image_urls": []string{"https://cdn.example.com/first.png", "https://cdn.example.com/last.png"},
	})
	if got["first_frame_image"] != "https://cdn.example.com/first.png" || got["last_frame_image"] != "https://cdn.example.com/last.png" {
		t.Fatalf("APIMart MiniMax H3 named frames = %#v", got)
	}
	if got["generation_mode"] != "image-to-video" || got["resolution"] != "768P" {
		t.Fatalf("APIMart MiniMax H3 image enums = %#v", got)
	}
	if _, ok := got["image_urls"]; ok {
		t.Fatalf("APIMart MiniMax H3 image mode leaked reference image array: %#v", got)
	}
}

func TestAPIMartHailuoKeepsFirstAndLastFrames(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "minimax-hailuo-2.1", "prompt": "animate", "seconds": 6,
		"reference_image_urls": []string{
			"https://cdn.example.com/first.png",
			"https://cdn.example.com/last.png",
		},
	})
	if got["first_frame_image"] != "https://cdn.example.com/first.png" || got["last_frame_image"] != "https://cdn.example.com/last.png" {
		t.Fatalf("APIMart Hailuo frame fields = %#v", got)
	}
}

func TestAPIMartViduImageDerivesAspectFromSource(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "vidu", "prompt": "animate", "size": "16:9", "resolution": "1080p",
		"reference_image_urls": []string{"https://cdn.example.com/reference.png"},
	})
	if _, ok := got["aspect_ratio"]; ok {
		t.Fatalf("APIMart Vidu image request leaked aspect_ratio: %#v", got)
	}
	if _, ok := got["image_urls"]; !ok {
		t.Fatalf("APIMart Vidu image request lost image_urls: %#v", got)
	}
}

func TestAPIMartNormalizationMatchesReferenceInputContracts(t *testing.T) {
	const image = "https://cdn.example.com/frame.png"
	const video = "https://cdn.example.com/source.mp4"
	for _, test := range []struct {
		name  string
		input map[string]any
		check func(*testing.T, map[string]any)
	}{
		{
			name:  "Sora image reference uses native array",
			input: map[string]any{"model": "sora-2", "provider": "apimart", "prompt": "animate", "size": "16:9", "reference_image_urls": []string{image}},
			check: func(t *testing.T, got map[string]any) {
				if refs, ok := got["image_urls"].([]string); !ok || len(refs) != 1 || refs[0] != image {
					t.Fatalf("Sora image_urls = %#v", got)
				}
				if _, ok := got["input_reference"]; ok {
					t.Fatalf("Sora leaked input_reference: %#v", got)
				}
			},
		},
		{
			name:  "Hailuo drops unsupported aspect and keeps uppercase resolution",
			input: map[string]any{"model": "minimax-hailuo-2-1", "provider": "apimart", "prompt": "animate", "size": "16:9", "resolution": "720p", "reference_image_urls": []string{image}},
			check: func(t *testing.T, got map[string]any) {
				if _, ok := got["aspect_ratio"]; ok {
					t.Fatalf("Hailuo leaked aspect_ratio: %#v", got)
				}
				if got["resolution"] != "720p" {
					t.Fatalf("Hailuo resolution = %#v", got["resolution"])
				}
			},
		},
		{
			name:  "Kling Omni derives mode from quality",
			input: map[string]any{"model": "kling-v3-omni", "provider": "apimart", "prompt": "animate", "resolution": "1080p"},
			check: func(t *testing.T, got map[string]any) {
				if got["mode"] != "pro" {
					t.Fatalf("Kling Omni mode = %#v", got["mode"])
				}
			},
		},
		{
			name:  "Wan 2.7 reference video removes conflicting audio",
			input: map[string]any{"model": "wan2-7-i2v", "provider": "apimart", "prompt": "animate", "reference_image_urls": []string{image}, "reference_video_urls": []string{video}, "reference_audio_urls": []string{"https://cdn.example.com/voice.mp3"}},
			check: func(t *testing.T, got map[string]any) {
				if _, ok := got["audio_url"]; ok {
					t.Fatalf("Wan 2.7 leaked audio_url with video reference: %#v", got)
				}
				if _, ok := got["video_urls"]; !ok {
					t.Fatalf("Wan 2.7 lost video_urls: %#v", got)
				}
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			test.check(t, officialVideoRequestPayload(test.input))
		})
	}
}

func TestAPIMartReferenceConflictsMatchReferenceProject(t *testing.T) {
	const image = "https://cdn.example.com/frame.png"
	const ordinaryImage = "https://cdn.example.com/reference.png"
	const video = "https://cdn.example.com/source.mp4"
	const audio = "https://cdn.example.com/source.mp3"

	seedance := officialVideoRequestPayload(map[string]any{
		"model": "doubao-seedance-2-0", "provider": "apimart", "prompt": "animate",
		"first_frame_url":      image,
		"reference_image_urls": []string{ordinaryImage},
		"reference_video_urls": []string{video},
		"reference_audio_urls": []string{audio},
	})
	if _, ok := seedance["image_with_roles"]; !ok {
		t.Fatalf("Seedance 2 lost image_with_roles: %#v", seedance)
	}
	if _, ok := seedance["image_urls"]; ok {
		t.Fatalf("Seedance 2 leaked image_urls alongside roles: %#v", seedance)
	}
	roles, ok := seedance["image_with_roles"].([]map[string]string)
	if !ok || len(roles) != 1 || roles[0]["role"] != "first_frame" || roles[0]["url"] != image {
		t.Fatalf("Seedance 2 roles = %#v", seedance["image_with_roles"])
	}
	if _, ok := seedance["first_frame_url"]; ok {
		t.Fatalf("Seedance 2 leaked the compatibility first_frame_url: %#v", seedance)
	}
	if _, ok := seedance["video_urls"]; ok {
		t.Fatalf("Seedance 2 leaked video_urls with first-frame role: %#v", seedance)
	}
	if _, ok := seedance["audio_urls"]; ok {
		t.Fatalf("Seedance 2 leaked audio_urls with first-frame role: %#v", seedance)
	}

	seedanceReference := officialVideoRequestPayload(map[string]any{
		"model": "doubao-seedance-2-0", "provider": "apimart", "prompt": "animate",
		"reference_mode": "reference", "reference_image_urls": []string{image},
		"reference_video_urls": []string{video}, "reference_audio_urls": []string{audio},
	})
	if _, ok := seedanceReference["video_urls"]; !ok {
		t.Fatalf("Seedance 2 reference mode lost video_urls: %#v", seedanceReference)
	}
	if _, ok := seedanceReference["audio_urls"]; !ok {
		t.Fatalf("Seedance 2 reference mode lost audio_urls: %#v", seedanceReference)
	}
	if _, ok := seedanceReference["image_urls"]; !ok {
		t.Fatalf("Seedance 2 reference mode lost image_urls: %#v", seedanceReference)
	}

	omni := officialVideoRequestPayload(map[string]any{
		"model": "omni-flash-ext", "provider": "apimart", "prompt": "animate",
		"seconds": 10, "reference_video_urls": []string{video},
	})
	if _, ok := omni["duration"]; ok {
		t.Fatalf("omni-flash-ext leaked duration with video reference: %#v", omni)
	}
}

func TestKIESeedanceKeepsNamedFramesSeparateFromOrdinaryReferences(t *testing.T) {
	first := "https://cdn.example.com/first.png"
	last := "https://cdn.example.com/last.png"
	ordinary := "https://cdn.example.com/reference.png"
	video := "https://cdn.example.com/reference.mp4"
	audio := "https://cdn.example.com/reference.mp3"

	got := officialVideoRequestPayload(map[string]any{
		"model": "bytedance/seedance-2", "prompt": "animate", "seconds": 5,
		"reference_mode":       "reference",
		"first_frame_url":      first,
		"last_frame_url":       last,
		"reference_image_urls": []string{ordinary},
		"reference_video_urls": []string{video},
		"reference_audio_urls": []string{audio},
	})
	if got["first_frame_url"] != first || got["last_frame_url"] != last {
		t.Fatalf("KIE Seedance named frames = %#v, payload=%#v", []any{got["first_frame_url"], got["last_frame_url"]}, got)
	}
	if refs, ok := got["reference_image_urls"].([]string); !ok || !reflect.DeepEqual(refs, []string{ordinary}) {
		t.Fatalf("KIE Seedance ordinary image references = %#v, payload=%#v", got["reference_image_urls"], got)
	}
	if refs, ok := got["reference_video_urls"].([]string); !ok || !reflect.DeepEqual(refs, []string{video}) {
		t.Fatalf("KIE Seedance video references = %#v, payload=%#v", got["reference_video_urls"], got)
	}
	if refs, ok := got["reference_audio_urls"].([]string); !ok || !reflect.DeepEqual(refs, []string{audio}) {
		t.Fatalf("KIE Seedance audio references = %#v, payload=%#v", got["reference_audio_urls"], got)
	}
}

func TestKIEWan27ImageToVideoSupportsNamedFirstAndLastFrames(t *testing.T) {
	got := officialVideoRequestPayload(map[string]any{
		"model": "wan/2-7-image-to-video", "prompt": "animate",
		"reference_image_urls": []string{
			"https://cdn.example.com/first.png",
			"https://cdn.example.com/second.png",
		},
	})
	if got["first_frame_url"] != "https://cdn.example.com/first.png" {
		t.Fatalf("KIE Wan 2.7 first_frame_url = %#v, payload=%#v", got["first_frame_url"], got)
	}
	if got["last_frame_url"] != "https://cdn.example.com/second.png" {
		t.Fatalf("KIE Wan 2.7 last_frame_url = %#v, payload=%#v", got["last_frame_url"], got)
	}
}
