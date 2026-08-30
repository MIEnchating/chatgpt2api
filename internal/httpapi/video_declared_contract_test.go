package httpapi

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
)

func TestDeclaredVideoContractRequestPayload(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		want    map[string]any
	}{
		{
			name: "text",
			payload: map[string]any{
				"model": "minimax-h3-768p", "prompt": "city at night", "seconds": 5,
				"size": "9:16", "resolution": "768p", "watermark": true,
			},
			want: map[string]any{
				"model": "minimax-h3-768p", "prompt": "city at night", "duration": 5,
				"ratio": "9:16", "resolution": "768p", "aigc_watermark": true, "generation_mode": "text-to-video",
			},
		},
		{
			name: "image",
			payload: map[string]any{
				"model": "minimax-h3-768p-enhanced", "prompt": "camera push", "seconds": 8,
				"size": "auto", "resolution": "768p",
				"first_frame_url": "https://cdn.example.com/first.png", "last_frame_url": "https://cdn.example.com/last.png",
			},
			want: map[string]any{
				"model": "minimax-h3-768p-enhanced", "prompt": "camera push", "duration": 8,
				"ratio": "auto", "resolution": "768p", "generation_mode": "image-to-video",
				"image_url": "https://cdn.example.com/first.png", "last_image_url": "https://cdn.example.com/last.png",
			},
		},
		{
			name: "reference",
			payload: map[string]any{
				"model": "minimax-h3-768p", "prompt": "use references", "reference_mode": "reference",
				"reference_image_urls": []string{"https://cdn.example.com/image.png"},
				"reference_video_urls": []string{"https://cdn.example.com/video.mp4"},
				"reference_audio_urls": []string{"https://cdn.example.com/audio.mp3"},
			},
			want: map[string]any{
				"model": "minimax-h3-768p", "prompt": "use references", "duration": 5,
				"ratio": "16:9", "resolution": "768p", "generation_mode": "reference-to-video",
				"reference_image_urls": []string{"https://cdn.example.com/image.png"},
				"reference_video_urls": []string{"https://cdn.example.com/video.mp4"},
				"reference_audio_urls": []string{"https://cdn.example.com/audio.mp3"},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			contract, ok := protocol.VideoContractForModel(test.payload["model"].(string))
			if !ok {
				t.Fatal("test model did not match a video contract")
			}
			if got := declaredVideoContractRequestPayload(test.payload, contract); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("declaredVideoContractRequestPayload() = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestVideoTaskRequestMetadataCarriesContractSnapshotTimeout(t *testing.T) {
	contract := protocol.DefaultVideoContracts()[0]
	metadata := videoTaskRequestMetadata(map[string]any{}, contract)
	if !reflect.DeepEqual(metadata[protocol.VideoContractSnapshotPayloadKey], contract) {
		t.Fatal("video task metadata did not carry the contract snapshot")
	}
	wantTimeout := contract.Polling.TimeoutSeconds + contract.Polling.IntervalSeconds
	if got := metadata[service.VideoTaskTimeoutSecondsPayloadKey]; got != wantTimeout {
		t.Fatalf("video task timeout = %#v, want %d", got, wantTimeout)
	}
}

func TestVideoTaskUsesStoredContractSnapshot(t *testing.T) {
	t.Cleanup(func() { _ = protocol.ReplaceVideoContracts(protocol.DefaultVideoContracts()) })
	snapshot := protocol.DefaultVideoContracts()[0]
	snapshot.Request.AspectRatioField = "snapshot_ratio"
	active := snapshot
	active.Request.AspectRatioField = "active_ratio"
	if err := protocol.ReplaceVideoContracts([]protocol.VideoModelContract{active}); err != nil {
		t.Fatalf("ReplaceVideoContracts() error = %v", err)
	}
	payload := map[string]any{
		"model": "minimax-h3-768p", "prompt": "city", "size": "9:16",
		protocol.VideoContractSnapshotPayloadKey: snapshot,
	}
	contract, err := videoContractSnapshot(payload, "minimax-h3-768p")
	if err != nil {
		t.Fatalf("videoContractSnapshot() error = %v", err)
	}
	request := declaredVideoContractRequestPayload(payload, contract)
	if request["snapshot_ratio"] != "9:16" || request["active_ratio"] != nil {
		t.Fatalf("request did not use stored contract snapshot: %#v", request)
	}
}

func TestVideoTaskRejectsMissingOrMismatchedContractSnapshot(t *testing.T) {
	if _, err := videoContractSnapshot(map[string]any{}, "minimax-h3-768p"); err == nil {
		t.Fatal("missing contract snapshot was accepted")
	}
	contract := protocol.DefaultVideoContracts()[0]
	payload := map[string]any{protocol.VideoContractSnapshotPayloadKey: contract}
	if _, err := videoContractSnapshot(payload, "another-video-model"); err == nil {
		t.Fatal("mismatched contract snapshot was accepted")
	}
}

func TestVideoContractDriverPathsAreDeclaredByContract(t *testing.T) {
	base := protocol.DefaultVideoContracts()[0]
	coveredDrivers := make(map[string]bool)
	tests := []struct {
		name       string
		driver     string
		mode       string
		createPath string
		queryPath  string
	}{
		{name: "OpenAI", driver: protocol.VideoContractDriverOpenAI, mode: "text-to-video", createPath: "/v1/videos", queryPath: "/v1/videos/"},
		{name: "xAI", driver: protocol.VideoContractDriverXAI, mode: "text-to-video", createPath: "/v1/videos", queryPath: "/v1/videos/"},
		{name: "Gemini Veo", driver: protocol.VideoContractDriverGeminiVeo, mode: "text-to-video", createPath: "/v1/videos", queryPath: "/v1/videos/"},
		{name: "Vertex Veo", driver: protocol.VideoContractDriverVertexVeo, mode: "text-to-video", createPath: "/v1/videos", queryPath: "/v1/videos/"},
		{name: "DashScope", driver: protocol.VideoContractDriverDashScope, mode: "text-to-video", createPath: "/v1/videos", queryPath: "/v1/videos/"},
		{name: "Volcengine", driver: protocol.VideoContractDriverVolcengine, mode: "text-to-video", createPath: "/v1/videos", queryPath: "/v1/videos/"},
		{name: "Kling text", driver: protocol.VideoContractDriverKling, mode: "text-to-video", createPath: "/kling/v1/videos/text2video", queryPath: "/kling/v1/videos/text2video/"},
		{name: "Kling image", driver: protocol.VideoContractDriverKling, mode: "image-to-video", createPath: "/kling/v1/videos/image2video", queryPath: "/kling/v1/videos/image2video/"},
		{name: "MiniMax", driver: protocol.VideoContractDriverMiniMax, mode: "text-to-video", createPath: "/v1/videos", queryPath: "/v1/videos/"},
		{name: "Vidu", driver: protocol.VideoContractDriverVidu, mode: "text-to-video", createPath: "/v1/videos", queryPath: "/v1/videos/"},
		{name: "KIE", driver: protocol.VideoContractDriverKIE, mode: "text-to-video", createPath: "/v1/videos", queryPath: "/v1/videos/"},
		{name: "APIMart", driver: protocol.VideoContractDriverAPIMart, mode: "text-to-video", createPath: "/v1/videos", queryPath: "/v1/videos/"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			coveredDrivers[test.driver] = true
			contract := base
			contract.Driver = test.driver
			createPath, queryPath, err := videoContractDriverPaths(contract, map[string]any{"generation_mode": test.mode})
			if err != nil || createPath != test.createPath || queryPath != test.queryPath {
				t.Fatalf("videoContractDriverPaths() = %q, %q, %v; want %q, %q", createPath, queryPath, err, test.createPath, test.queryPath)
			}
		})
	}
	for _, driver := range protocol.SupportedVideoContractDrivers() {
		if !coveredDrivers[driver] {
			t.Errorf("supported video driver %q has no declared runtime path test", driver)
		}
	}
}

func TestDeclaredVideoContractRequestPayloadSupportsNestedFields(t *testing.T) {
	contract := protocol.DefaultVideoContracts()[0]
	contract.Request.DurationField = "metadata.durationSeconds"
	contract.Request.AspectRatioField = "metadata.aspectRatio"
	contract.Request.ResolutionField = "metadata.resolution"
	contract.Request.GenerateAudioField = "metadata.generateAudio"
	contract.Request.WatermarkField = "metadata.watermark"
	contract.Request.GenerationModeField = "metadata.generationMode"

	got := declaredVideoContractRequestPayload(map[string]any{
		"model": "minimax-h3-768p", "prompt": "city at night", "seconds": 8,
		"size": "16:9", "resolution": "1080p", "generate_audio": true, "watermark": false,
	}, contract)
	wantMetadata := map[string]any{
		"durationSeconds": 8,
		"aspectRatio":     "16:9",
		"resolution":      "1080p",
		"generateAudio":   true,
		"watermark":       false,
		"generationMode":  "text-to-video",
	}
	if !reflect.DeepEqual(got["metadata"], wantMetadata) {
		t.Fatalf("nested metadata = %#v, want %#v", got["metadata"], wantMetadata)
	}
	for _, field := range []string{"durationSeconds", "aspectRatio", "resolution", "generateAudio", "watermark", "generationMode"} {
		if _, exists := got[field]; exists {
			t.Fatalf("nested field %q leaked to request root: %#v", field, got)
		}
	}
}

func TestVideoContractResponseFieldPaths(t *testing.T) {
	contract := protocol.DefaultVideoContracts()[0]
	contract.Polling.TaskIDFields = []string{"data.task.id"}
	contract.Polling.StatusFields = []string{"data.task.status"}
	contract.Polling.ErrorFields = []string{"data.task.error.message"}
	contract.Polling.ResultFields = []string{"data.outputs[0].url"}
	state := map[string]any{"data": map[string]any{
		"task": map[string]any{
			"id": "task-123", "status": "failed",
			"error": map[string]any{"message": "upstream rejected the request"},
		},
		"outputs": []any{map[string]any{"url": "https://cdn.example.com/video.mp4"}},
	}}
	if taskID := videoContractFirstString(state, contract.Polling.TaskIDFields); taskID != "task-123" {
		t.Fatalf("task ID = %q", taskID)
	}
	if status := videoRelayTaskStatusForContract(state, contract); status != "failed" {
		t.Fatalf("status = %q", status)
	}
	if message := videoContractErrorMessage(state, contract); message != "upstream rejected the request" {
		t.Fatalf("error message = %q", message)
	}
	if result := videoResultURLForContract(state, "https://relay.example", contract); result != "https://cdn.example.com/video.mp4" {
		t.Fatalf("result URL = %q", result)
	}
	if value := videoJSONPathValue(state, "data.outputs[1].url"); value != nil {
		t.Fatalf("out-of-range response path = %#v", value)
	}
	encoded := map[string]any{"data": map[string]any{"resultJson": `{"resultUrls":["https://cdn.example.com/encoded.mp4"]}`}}
	if value := videoJSONPathValue(encoded, "data.resultJson.resultUrls[0]"); value != "https://cdn.example.com/encoded.mp4" {
		t.Fatalf("encoded response path = %#v", value)
	}
}

func TestDeclaredVideoContractExplicitGenerationModeTakesPriority(t *testing.T) {
	contract, ok := protocol.VideoContractForModel("minimax-h3-768p")
	if !ok {
		t.Fatal("MiniMax H3 contract is not installed")
	}
	got := declaredVideoContractRequestPayload(map[string]any{
		"model":                "minimax-h3-768p",
		"prompt":               "use the supplied material",
		"generation_mode":      "reference-to-video",
		"reference_image_urls": []string{"https://cdn.example.com/only.png"},
	}, contract)
	if got["generation_mode"] != "reference-to-video" {
		t.Fatalf("generation_mode = %#v", got["generation_mode"])
	}
	if refs := got["reference_image_urls"]; !reflect.DeepEqual(refs, []string{"https://cdn.example.com/only.png"}) {
		t.Fatalf("reference_image_urls = %#v", refs)
	}
	if _, exists := got["image_url"]; exists {
		t.Fatalf("explicit reference mode was converted to image mode: %#v", got)
	}
}

func TestDeclaredVideoContractGenerationModeValidation(t *testing.T) {
	contract, ok := protocol.VideoContractForModel("minimax-h3-768p")
	if !ok {
		t.Fatal("MiniMax H3 contract is not installed")
	}
	for _, test := range []struct {
		value string
		kind  string
		valid bool
	}{
		{value: "text-to-video", kind: "text", valid: true},
		{value: "IMAGE-TO-VIDEO", kind: "image", valid: true},
		{value: "reference-to-video", kind: "reference", valid: true},
		{value: "unsupported-mode", valid: false},
	} {
		kind, valid := videoContractGenerationKind(map[string]any{"generation_mode": test.value}, contract)
		if kind != test.kind || valid != test.valid {
			t.Fatalf("generation_mode %q = kind %q valid %v", test.value, kind, valid)
		}
	}

	referenceCounts := videoContractMaterialCounts("reference", map[string]any{}, []string{"https://cdn.example.com/ref.png"}, nil, nil)
	if err := protocol.ValidateVideoContractModeMaterials(contract, "reference", referenceCounts); err != nil {
		t.Fatalf("valid explicit reference mode rejected: %v", err)
	}
	textCounts := videoContractMaterialCounts("text", map[string]any{}, []string{"https://cdn.example.com/ref.png"}, nil, nil)
	if err := protocol.ValidateVideoContractModeMaterials(contract, "text", textCounts); err == nil {
		t.Fatal("explicit text mode accepted reference material")
	}
	imageCounts := videoContractMaterialCounts("image", map[string]any{}, []string{"https://cdn.example.com/frame.png"}, nil, nil)
	if err := protocol.ValidateVideoContractModeMaterials(contract, "image", imageCounts); err != nil {
		t.Fatalf("valid explicit image mode rejected: %v", err)
	}
}

func TestDeclaredVideoContractRouteRejectsInvalidOrMismatchedGenerationMode(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	if _, err := app.config.Update(map[string]any{"video_models": []string{"minimax-h3-768p"}}); err != nil {
		t.Fatalf("configure video models: %v", err)
	}
	token := adminSessionToken(t, app)
	for _, body := range []string{
		`{"prompt":"animate"}`,
		`{"model":"minimax-h3-768p","prompt":"animate","generation_mode":"unsupported-mode"}`,
		`{"model":"minimax-h3-768p","prompt":"animate","generation_mode":"text-to-video","reference_image_urls":["https://cdn.example.com/ref.png"]}`,
		`{"model":"minimax-h3-768p","prompt":"animate","generation_mode":"reference-to-video"}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/creation-tasks/video-generations", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		setRequestAuthCookie(req, token)
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("request %s status = %d body = %s", body, res.Code, res.Body.String())
		}
	}
}

func TestDeclaredVideoContractAllowsProtocolEncodedGenerationModeAndAppliesForceValues(t *testing.T) {
	contract := protocol.DefaultVideoContracts()[0]
	contract.Request.GenerationModeField = ""
	if _, err := protocol.NormalizeVideoModelContract(contract); err != nil {
		t.Fatalf("contract without generation mode field was rejected: %v", err)
	}
	contract = protocol.DefaultVideoContracts()[0]
	contract.Capability.AudioControl = "toggle"
	contract.Request.GenerateAudioField = "sound"
	contract.Rules = append(contract.Rules, protocol.VideoModelContractRule{
		When:        protocol.VideoModelContractRuleCondition{Field: "generate_audio", Operator: "equals", Value: "true"},
		ForceValues: map[string]string{"duration": "8", "watermark": "true"},
		Message:     "音频生成参数无效",
	})
	payload := map[string]any{
		"model": "minimax-h3-768p", "prompt": "city", "generate_audio": true,
	}
	got := declaredVideoContractRequestPayload(payload, contract)
	if got["generation_mode"] != "text-to-video" {
		t.Fatalf("generation mode was not explicit: %#v", got)
	}
	if got["duration"] != 8 || got["sound"] != true || got["aigc_watermark"] != true {
		t.Fatalf("forced contract request values = %#v", got)
	}
}

func TestDeclaredVideoContractValidation(t *testing.T) {
	contract, ok := protocol.VideoContractForModel("minimax-h3-768p")
	if !ok {
		t.Fatal("MiniMax H3 contract is not installed")
	}
	valid := []struct {
		size       string
		seconds    int
		resolution string
	}{
		{size: "auto", seconds: 4, resolution: "768p"},
		{size: "21:9", seconds: 15, resolution: "768P"},
	}
	for _, input := range valid {
		if !protocol.VideoCapabilitySupports(protocol.VideoCapability("minimax-h3-768p"), input.size, input.seconds, input.resolution) {
			t.Fatalf("valid declared parameters rejected: %#v", input)
		}
	}
	for _, input := range []struct {
		size       string
		seconds    int
		resolution string
		total      int
	}{
		{size: "adaptive", seconds: 5, resolution: "768p"},
		{size: "16:9", seconds: 3, resolution: "768p"},
		{size: "16:9", seconds: 16, resolution: "768p"},
		{size: "16:9", seconds: 5, resolution: "2k"},
		{size: "16:9", seconds: 5, resolution: "768p", total: 13},
	} {
		parametersValid := protocol.VideoCapabilitySupports(protocol.VideoCapability("minimax-h3-768p"), input.size, input.seconds, input.resolution)
		materialValid := protocol.ValidateVideoContractModeMaterials(contract, "reference", protocol.VideoModelMaterialCounts{Image: input.total}) == nil
		if parametersValid && materialValid {
			t.Fatalf("invalid declared parameters accepted: %#v", input)
		}
	}
	if len([]rune(strings.Repeat("字", 5000))) > contract.Validation.MaxPromptCharacters {
		t.Fatal("prompt at declared limit rejected")
	}
	if len([]rune(strings.Repeat("字", 5001))) <= contract.Validation.MaxPromptCharacters {
		t.Fatal("prompt above declared limit was accepted")
	}
}

func TestDeclaredVideoContractReferenceAndPollingRules(t *testing.T) {
	contract, _ := protocol.VideoContractForModel("minimax-h3-768p")
	if err := protocol.ValidateVideoContractModeMaterials(contract, "reference", protocol.VideoModelMaterialCounts{Audio: 1}); err != nil {
		t.Fatalf("declared audio-only reference rejected: %v", err)
	}
	images := make([]string, 9)
	for index := range images {
		images[index] = "https://cdn.example.com/image.png"
	}
	videos := []string{"https://cdn.example.com/one.mp4", "https://cdn.example.com/two.mp4", "https://cdn.example.com/three.mp4"}
	audios := []string{"https://cdn.example.com/one.mp3"}
	if err := protocol.ValidateVideoContractModeMaterials(contract, "reference", protocol.VideoModelMaterialCounts{Image: len(images), Video: len(videos)}); err != nil {
		t.Fatalf("12 declared references rejected: %v", err)
	}
	if err := protocol.ValidateVideoContractModeMaterials(contract, "reference", protocol.VideoModelMaterialCounts{Image: len(images), Video: len(videos), Audio: len(audios)}); err == nil {
		t.Fatal("13 declared references were accepted")
	}

	if got := videoRelayTaskStatusForContract(map[string]any{"status": "queued"}, contract); got != "queued" {
		t.Fatalf("queued status = %q", got)
	}
	if got := videoRelayTaskStatusForContract(map[string]any{"status": "in_progress"}, contract); got != "in_progress" {
		t.Fatalf("in_progress status = %q", got)
	}
	if got := videoRelayTaskStatusForContract(map[string]any{"status": "enhancing"}, contract); got != "unknown" {
		t.Fatalf("unknown enhancing status = %q", got)
	}
	if got := videoRelayTaskStatusForContract(map[string]any{"status": "cancelled"}, contract); got != "failed" {
		t.Fatalf("cancelled status = %q", got)
	}
	if progress, ok := videoContractProgressForContract(map[string]any{"progress": "37%"}, contract); !ok || progress != 37 {
		t.Fatalf("progress = %d, %v", progress, ok)
	}
	state := map[string]any{"video_url": "https://cdn.example.com/result.mp4"}
	if got := videoResultURLForContract(state, "https://api.example.com", contract); got != "https://cdn.example.com/result.mp4" {
		t.Fatalf("contract result URL = %q", got)
	}
}
