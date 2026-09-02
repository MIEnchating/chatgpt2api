package protocol

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestVideoModelContractJSONKeepsV4Fields(t *testing.T) {
	data, err := json.Marshal(DefaultVideoContracts()[0])
	if err != nil {
		t.Fatalf("marshal contract: %v", err)
	}
	for _, field := range []string{
		`"multipart_file_field"`, `"multipart_repeatable"`, `"multipart_mixed_urls"`,
		`"create_path"`, `"query_path"`, `"content_path"`, `"allowed_hosts"`,
	} {
		if !strings.Contains(string(data), field) {
			t.Fatalf("serialized v4 contract is missing %s: %s", field, data)
		}
	}
}

func TestCloneVideoContractsCopiesNestedState(t *testing.T) {
	source := DefaultVideoContracts()
	source[0].Artifact.AllowedHosts = []string{"source.example"}
	source[0].Rules[0].Limits = map[string]int{"reference_image": 1}
	source[0].Rules[0].UI.Hide = []string{"watermark"}
	cloned := cloneVideoContracts(source)
	cloned[0].Models[0] = "mutated-model"
	cloned[0].Artifact.AllowedHosts[0] = "mutated.example"
	cloned[0].Generation.Modes[0].Label = "mutated mode"
	cloned[0].Rules[0].Limits["reference_image"] = 999
	cloned[0].Rules[0].UI.Hide[0] = "duration"
	cloned[0].Polling.ResultFields[0] = "mutated.result"

	if source[0].Models[0] == "mutated-model" ||
		!slices.Contains(source[0].Artifact.AllowedHosts, "source.example") ||
		source[0].Generation.Modes[0].Label == "mutated mode" ||
		source[0].Rules[0].Limits["reference_image"] != 1 ||
		!slices.Contains(source[0].Rules[0].UI.Hide, "watermark") ||
		source[0].Polling.ResultFields[0] == "mutated.result" {
		t.Fatalf("cloneVideoContracts() shared nested state: %#v", source[0])
	}
}

func TestMiniMaxH3DeclaredVideoContract(t *testing.T) {
	for _, model := range []string{"minimax-h3-768p", "minimax-h3-768p-enhanced"} {
		contract, ok := VideoContractForModel(model)
		if !ok {
			t.Fatalf("VideoContractForModel(%q) did not match", model)
		}
		if contract.Name != "MiniMax H3 v1.8" || contract.Driver != VideoContractDriverMiniMax || contract.Transport.LocalMaterial != "multipart" || contract.Transport.MultipartFileField != "input_reference[]" {
			t.Fatalf("VideoContractForModel(%q) = %#v", model, contract)
		}
		capability := contract.Capability
		if capability.DefaultSeconds != 5 || capability.DefaultSize != "16:9" || capability.DefaultResolution != "768p" {
			t.Fatalf("contract capability for %q defaults = %#v", model, capability)
		}
		if len(capability.Resolutions) != 1 || capability.Resolutions[0] != "768p" {
			t.Fatalf("contract capability for %q resolutions = %#v", model, capability.Resolutions)
		}
		if contract.Capability.References.Total != 12 || contract.Validation.MaxPromptCharacters != 5000 {
			t.Fatalf("VideoContractForModel(%q) limits = %#v", model, contract)
		}
	}
	if _, ok := VideoContractForModel("minimax-h3-768p-unknown"); ok {
		t.Fatal("an undeclared model matched the H3 contract")
	}
}

func TestVideoContractModelMatchingPriority(t *testing.T) {
	t.Cleanup(func() {
		if err := ReplaceVideoContracts(DefaultVideoContracts()); err != nil {
			t.Fatalf("reset video contracts: %v", err)
		}
	})
	base := DefaultVideoContracts()[0]
	broad := base
	broad.Name = "MiniMax family"
	broad.Models = []string{"minimax-*"}
	broad.Priority = 900
	specific := base
	specific.Name = "MiniMax H3 family"
	specific.Models = []string{"minimax-h3-*"}
	specific.Priority = -900
	exact := base
	exact.Name = "MiniMax H3 768p"
	exact.Models = []string{"minimax-h3-768p"}
	if err := ReplaceVideoContracts([]VideoModelContract{broad, specific, exact}); err != nil {
		t.Fatalf("ReplaceVideoContracts() error = %v", err)
	}
	for model, want := range map[string]string{
		"minimax-video-01":  broad.Name,
		"minimax-h3-custom": specific.Name,
		"MINIMAX-H3-768P":   exact.Name,
	} {
		contract, ok := VideoContractForModel(model)
		if !ok || contract.Name != want {
			t.Fatalf("VideoContractForModel(%q) = %#v, %v; want %q", model, contract, ok, want)
		}
	}
	if _, ok := VideoContractForModel("unconfigured-video"); ok {
		t.Fatal("unconfigured model matched a contract")
	}
}

func TestVideoContractRejectsAmbiguousWildcardRules(t *testing.T) {
	base := DefaultVideoContracts()[0]
	left := base
	left.Name = "Left"
	left.Models = []string{"a*b"}
	right := base
	right.Name = "Right"
	right.Models = []string{"ab*"}
	if err := ValidateVideoContracts([]VideoModelContract{left, right}); err == nil {
		t.Fatal("overlapping wildcard rules with equal priority were accepted")
	}
	right.Priority = 1
	if err := ValidateVideoContracts([]VideoModelContract{left, right}); err != nil {
		t.Fatalf("priority did not resolve wildcard ambiguity: %v", err)
	}
}

func TestVideoContractMatchingDoesNotRewriteModelID(t *testing.T) {
	t.Cleanup(func() { _ = ReplaceVideoContracts(DefaultVideoContracts()) })
	contract := DefaultVideoContracts()[0]
	contract.Name = "Literal model ID"
	contract.Models = []string{"kling/text-to-video"}
	if err := ReplaceVideoContracts([]VideoModelContract{contract}); err != nil {
		t.Fatalf("ReplaceVideoContracts() error = %v", err)
	}
	if _, ok := VideoContractForModel("kling/text-to-video"); !ok {
		t.Fatal("literal model ID did not match")
	}
	if _, ok := VideoContractForModel("kling-2.6/text-to-video"); ok {
		t.Fatal("canonical alias unexpectedly matched a literal model ID")
	}
}

func TestCustomVideoModelContractRegistry(t *testing.T) {
	t.Cleanup(func() {
		if err := ReplaceVideoContracts(DefaultVideoContracts()); err != nil {
			t.Fatalf("reset video contracts: %v", err)
		}
	})
	contract := DefaultVideoContracts()[0]
	contract.Name = "Custom video v1"
	contract.Models = []string{"custom/video-v1"}
	if err := ReplaceVideoContracts([]VideoModelContract{contract}); err != nil {
		t.Fatalf("ReplaceVideoContracts() error = %v", err)
	}
	got, ok := VideoContractForModel("CUSTOM/video-v1")
	if !ok || got.Name != contract.Name {
		t.Fatalf("VideoContractForModel(custom) = %#v, %v", got, ok)
	}
	if _, ok := VideoContractForModel("minimax-h3-768p"); ok {
		t.Fatal("replaced contract registry retained a default contract")
	}

	duplicate := contract
	duplicate.Name = "Custom video v2"
	if err := ValidateVideoContracts([]VideoModelContract{contract, duplicate}); err == nil {
		t.Fatal("duplicate model mapping was accepted")
	}
	invalid := contract
	invalid.Driver = "javascript"
	if _, err := NormalizeVideoModelContract(invalid); err == nil {
		t.Fatal("unsupported driver was accepted")
	}
	invalid = contract
	invalid.Polling.FailureStatuses = append(invalid.Polling.FailureStatuses, invalid.Polling.SuccessStatuses[0])
	if _, err := NormalizeVideoModelContract(invalid); err == nil {
		t.Fatal("overlapping polling statuses were accepted")
	}
	invalid = contract
	invalid.Polling.RunningStatuses = append(invalid.Polling.RunningStatuses, invalid.Polling.QueuedStatuses[0])
	if _, err := NormalizeVideoModelContract(invalid); err == nil {
		t.Fatal("overlapping active polling statuses were accepted")
	}
}

func TestVideoContractAddsNewAPIActiveStatusDefaults(t *testing.T) {
	contract := DefaultVideoContracts()[0]
	contract.Polling.QueuedStatuses = nil
	contract.Polling.RunningStatuses = nil
	contract.Polling.ProgressFields = nil
	normalized, err := NormalizeVideoModelContract(contract)
	if err != nil {
		t.Fatalf("NormalizeVideoModelContract() error = %v", err)
	}
	if !reflect.DeepEqual(normalized.Polling.QueuedStatuses, []string{"queued"}) || !reflect.DeepEqual(normalized.Polling.RunningStatuses, []string{"in_progress"}) || !reflect.DeepEqual(normalized.Polling.ProgressFields, []string{"progress"}) {
		t.Fatalf("active status defaults = %#v", normalized.Polling)
	}
	contract = DefaultVideoContracts()[0]
	contract.Polling.ProgressFields = []string{}
	if normalized, err = NormalizeVideoModelContract(contract); err != nil || len(normalized.Polling.ProgressFields) != 0 {
		t.Fatalf("explicit empty progress fields = %#v, %v", normalized.Polling.ProgressFields, err)
	}
	contract = DefaultVideoContracts()[0]
	contract.Polling.QueuedStatuses = []string{}
	if _, err = NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("explicit empty queued statuses were accepted")
	}
}

func TestSupportedVideoContractDrivers(t *testing.T) {
	base := DefaultVideoContracts()[0]
	for _, driver := range SupportedVideoContractDrivers() {
		contract := base
		contract.Driver = driver
		if driver == VideoContractDriverKling {
			contract.Generation.Modes = contract.Generation.Modes[:2]
		}
		if driver == VideoContractDriverCustom {
			contract.Transport.CreatePath = "/vendor/tasks"
			contract.Transport.QueryPath = "/vendor/tasks/{task_id}"
		}
		if _, err := NormalizeVideoModelContract(contract); err != nil {
			t.Fatalf("supported driver %q rejected: %v", driver, err)
		}
	}
	for _, driver := range []string{"newapi-video", "kling-videos"} {
		contract := base
		contract.Driver = driver
		if _, err := NormalizeVideoModelContract(contract); err == nil {
			t.Fatalf("legacy gateway name %q was accepted as a protocol driver", driver)
		}
	}
}

func TestVideoContractValidatesPortableTransportAndArtifactSettings(t *testing.T) {
	contract := DefaultVideoContracts()[0]
	contract.Driver = VideoContractDriverCustom
	contract.Transport.CreatePath = "/vendor/tasks"
	contract.Transport.QueryPath = "/vendor/tasks/{task_id}"
	contract.Artifact = VideoModelContractArtifact{
		Mode:         "task_content",
		ContentPath:  "/vendor/tasks/{task_id}/content",
		Auth:         "relay",
		AllowedHosts: []string{"media.example.com", "*.cdn.example.com"},
	}
	contract.Polling.ResultFields = nil
	if _, err := NormalizeVideoModelContract(contract); err != nil {
		t.Fatalf("portable contract rejected: %v", err)
	}

	contract.Transport.QueryPath = "/vendor/tasks"
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("query path without task placeholder was accepted")
	}
	contract.Transport.QueryPath = "/vendor/tasks/{task_id}"
	contract.Transport.CreatePath = ""
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("query path without a create path was accepted")
	}
	contract.Transport.CreatePath = "/vendor/tasks/{task_id}"
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("create path with a task placeholder was accepted")
	}
	contract.Transport.CreatePath = "/vendor/{project}/tasks"
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("create path with an unsupported placeholder was accepted")
	}
	contract.Transport.CreatePath = "/vendor/tasks"
	contract.Transport.QueryPath = "/vendor/{project}/tasks/{task_id}"
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("query path with an unsupported placeholder was accepted")
	}
	contract.Transport.QueryPath = "/vendor/tasks/{task_id}"
	contract.Artifact.ContentPath = "/vendor/{project}/tasks/{task_id}/content"
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("content path with an unsupported placeholder was accepted")
	}
	contract.Artifact.ContentPath = "/vendor/tasks/{task_id}/content"
	contract.Artifact.Auth = "none"
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("task content without relay auth was accepted")
	}
}

func TestVideoContractAcceptsNestedRequestFieldPaths(t *testing.T) {
	contract := DefaultVideoContracts()[0]
	contract.Request.DurationField = "metadata.durationSeconds"
	contract.Request.AspectRatioField = "metadata.aspectRatio"
	contract.Request.ResolutionField = "metadata.resolution"
	contract.Request.GenerateAudioField = "metadata.generateAudio"
	contract.Request.WatermarkField = "metadata.watermark"
	contract.Request.GenerationModeField = "metadata.generationMode"
	if _, err := NormalizeVideoModelContract(contract); err != nil {
		t.Fatalf("nested request field paths were rejected: %v", err)
	}

	contract.Request.DurationField = "metadata..durationSeconds"
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("invalid nested request field path was accepted")
	}
}

func TestVideoContractGenerationModesAndRules(t *testing.T) {
	contract := DefaultVideoContracts()[0]

	validModes := []struct {
		kind   string
		counts VideoModelMaterialCounts
	}{
		{kind: "text"},
		{kind: "image", counts: VideoModelMaterialCounts{FirstFrame: 1, LastFrame: 1}},
		{kind: "reference", counts: VideoModelMaterialCounts{Image: 9, Video: 3}},
	}
	for _, test := range validModes {
		if err := ValidateVideoContractModeMaterials(contract, test.kind, test.counts); err != nil {
			t.Fatalf("valid %s mode rejected: %v", test.kind, err)
		}
	}
	invalidModes := []struct {
		kind   string
		counts VideoModelMaterialCounts
	}{
		{kind: "image", counts: VideoModelMaterialCounts{LastFrame: 1}},
		{kind: "image", counts: VideoModelMaterialCounts{FirstFrame: 1, Image: 1}},
		{kind: "reference"},
		{kind: "reference", counts: VideoModelMaterialCounts{Image: 10}},
		{kind: "reference", counts: VideoModelMaterialCounts{Image: 9, Video: 3, Audio: 1}},
	}
	for _, test := range invalidModes {
		if err := ValidateVideoContractModeMaterials(contract, test.kind, test.counts); err == nil {
			t.Fatalf("invalid %s mode accepted: %#v", test.kind, test.counts)
		}
	}
	if err := ValidateVideoContractRuleValues(contract, map[string]any{"last_frame": "tail.png"}); err == nil || !strings.Contains(err.Error(), "首帧") {
		t.Fatalf("last-frame dependency error = %v", err)
	}
	if err := ValidateVideoContractRuleValues(contract, map[string]any{"first_frame": "first.png", "last_frame": "tail.png"}); err != nil {
		t.Fatalf("valid first/last-frame pair rejected: %v", err)
	}
	for _, invalid := range []map[string]any{
		{"first_frame": "first.png", "reference_image": []string{"reference.png"}},
		{"first_frame": "first.png", "reference_video": []string{"reference.mp4"}},
		{"first_frame": "first.png", "reference_audio": []string{"reference.mp3"}},
	} {
		if err := ValidateVideoContractRuleValues(contract, invalid); err == nil || !strings.Contains(err.Error(), "不能同时使用") {
			t.Fatalf("mixed first-frame/reference materials error = %v for %#v", err, invalid)
		}
	}
	if err := ValidateVideoContractRuleValues(contract, map[string]any{
		"reference_image": []string{"reference.png"},
		"reference_video": []string{"reference.mp4"},
	}); err != nil {
		t.Fatalf("valid reference materials rejected: %v", err)
	}

	contract.Rules = []VideoModelContractRule{
		{
			When:        VideoModelContractRuleCondition{Field: "generate_audio", Operator: "equals", Value: "true"},
			RequireAny:  []string{"reference_image", "reference_video"},
			Forbid:      []string{"reference_audio"},
			Limits:      map[string]int{"reference_image": 1},
			ForceValues: map[string]string{"duration": "8", "watermark": "true"},
			UI:          VideoModelContractRuleUI{Hide: []string{"reference_audio"}, Disable: []string{"duration"}},
			Message:     "音频模式素材关系无效",
		},
	}
	values := map[string]any{"generate_audio": true, "reference_image": []string{"one.png"}}
	ApplyVideoContractForcedValues(contract, values)
	if values["duration"] != 8 || values["watermark"] != true {
		t.Fatalf("forced values = %#v", values)
	}
	if err := ValidateVideoContractRuleValues(contract, values); err != nil {
		t.Fatalf("valid conditional rule rejected: %v", err)
	}
	for _, invalid := range []map[string]any{
		{"generate_audio": true},
		{"generate_audio": true, "reference_video": []string{"one.mp4"}, "reference_audio": []string{"one.mp3"}},
		{"generate_audio": true, "reference_image": []string{"one.png", "two.png"}},
	} {
		if err := ValidateVideoContractRuleValues(contract, invalid); err == nil {
			t.Fatalf("invalid conditional rule accepted: %#v", invalid)
		}
	}
}

func TestVideoContractAppliesForcedBooleanTokens(t *testing.T) {
	tests := []struct {
		field    string
		value    string
		expected any
	}{
		{field: "generate_audio", value: "1", expected: true},
		{field: "generate_audio", value: "t", expected: true},
		{field: "watermark", value: "0", expected: false},
		{field: "watermark", value: "f", expected: false},
	}
	for _, test := range tests {
		t.Run(test.field+"_"+test.value, func(t *testing.T) {
			contract := DefaultVideoContracts()[0]
			contract.Rules = []VideoModelContractRule{{
				When:        VideoModelContractRuleCondition{Field: "duration", Operator: "present"},
				ForceValues: map[string]string{test.field: test.value},
				Message:     "forced value",
			}}
			normalized, err := NormalizeVideoModelContract(contract)
			if err != nil {
				t.Fatalf("NormalizeVideoModelContract() error = %v", err)
			}
			values := map[string]any{"duration": 4}
			ApplyVideoContractForcedValues(normalized, values)
			got, exists := values[test.field]
			if !exists || got != test.expected {
				t.Fatalf("force_values[%q]=%q applied as %#v, want %#v", test.field, test.value, got, test.expected)
			}
		})
	}
}

func TestVideoContractRejectsInvalidForcedValues(t *testing.T) {
	for _, test := range []struct {
		field string
		value string
	}{
		{field: "duration", value: "eight"},
		{field: "duration", value: "9007199254740993"},
		{field: "generate_audio", value: "yes"},
	} {
		t.Run(test.field+"_"+test.value, func(t *testing.T) {
			contract := DefaultVideoContracts()[0]
			contract.Rules = []VideoModelContractRule{{
				When:        VideoModelContractRuleCondition{Field: "duration", Operator: "present"},
				ForceValues: map[string]string{test.field: test.value},
				Message:     "forced value",
			}}
			if _, err := NormalizeVideoModelContract(contract); err == nil {
				t.Fatalf("invalid force_values[%q]=%q was accepted", test.field, test.value)
			}
		})
	}
}

func TestVideoContractNormalizesAndAppliesTypedForcedValues(t *testing.T) {
	contract := DefaultVideoContracts()[0]
	contract.Rules = []VideoModelContractRule{{
		When: VideoModelContractRuleCondition{Field: "duration", Operator: "present"},
		ForceValues: map[string]string{
			"duration":       " 08 ",
			"generate_audio": " TRUE ",
			"watermark":      " False ",
		},
		Message: "typed forced values",
	}}
	normalized, err := NormalizeVideoModelContract(contract)
	if err != nil {
		t.Fatalf("NormalizeVideoModelContract() error = %v", err)
	}
	forced := normalized.Rules[0].ForceValues
	if forced["generate_audio"] != "true" || forced["watermark"] != "false" {
		t.Fatalf("normalized boolean force values = %#v", forced)
	}
	values := map[string]any{"duration": 4}
	ApplyVideoContractForcedValues(normalized, values)
	if values["duration"] != 8 || values["generate_audio"] != true || values["watermark"] != false {
		t.Fatalf("applied force values = %#v", values)
	}
}

func TestVideoContractRuleMapNormalizationRejectsConflictingKeys(t *testing.T) {
	tests := []struct {
		name        string
		limits      map[string]int
		forceValues map[string]string
		wantField   string
	}{
		{
			name:      "limits",
			limits:    map[string]int{"duration": 4, " DURATION ": 8},
			wantField: "duration",
		},
		{
			name:        "force values",
			forceValues: map[string]string{"watermark": "true", " WATERMARK ": "false"},
			wantField:   "watermark",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			contract := DefaultVideoContracts()[0]
			contract.Rules = []VideoModelContractRule{{
				When:        VideoModelContractRuleCondition{Field: "duration", Operator: "present"},
				Limits:      test.limits,
				ForceValues: test.forceValues,
				Message:     "conflicting normalized keys",
			}}
			if _, err := NormalizeVideoModelContract(contract); err == nil || !strings.Contains(err.Error(), test.wantField) {
				t.Fatalf("NormalizeVideoModelContract() error = %v, want conflict for %q", err, test.wantField)
			}
		})
	}
}

func TestVideoContractRuleMapNormalizationCollapsesEquivalentKeys(t *testing.T) {
	contract := DefaultVideoContracts()[0]
	contract.Rules = []VideoModelContractRule{{
		When:        VideoModelContractRuleCondition{Field: "duration", Operator: "present"},
		Limits:      map[string]int{"duration": 8, " DURATION ": 8},
		ForceValues: map[string]string{"watermark": "TRUE", " WATERMARK ": " true "},
		Message:     "equivalent normalized keys",
	}}
	normalized, err := NormalizeVideoModelContract(contract)
	if err != nil {
		t.Fatalf("NormalizeVideoModelContract() error = %v", err)
	}
	rule := normalized.Rules[0]
	if len(rule.Limits) != 1 || rule.Limits["duration"] != 8 {
		t.Fatalf("normalized limits = %#v", rule.Limits)
	}
	if len(rule.ForceValues) != 1 || rule.ForceValues["watermark"] != "true" {
		t.Fatalf("normalized force values = %#v", rule.ForceValues)
	}
}

func TestVideoContractRuleNormalizationAndConflicts(t *testing.T) {
	contract := DefaultVideoContracts()[0]
	contract.Rules = []VideoModelContractRule{{
		When:    VideoModelContractRuleCondition{Field: "generate_audio", Operator: "present"},
		Require: []string{"size"}, RequireAny: []string{"size", "reference_image"},
		Message: "invalid",
	}}
	normalized, err := NormalizeVideoModelContract(contract)
	if err != nil {
		t.Fatalf("overlapping require and require_any rejected: %v", err)
	}
	if got := normalized.Rules[0].RequireAny; len(got) != 1 || got[0] != "reference_image" {
		t.Fatalf("normalized require_any = %#v", got)
	}
	contract.Rules[0].UI = VideoModelContractRuleUI{Show: []string{" WATERMARK ", "watermark"}, Disable: []string{"duration"}}
	normalized, err = NormalizeVideoModelContract(contract)
	if err != nil || len(normalized.Rules[0].UI.Show) != 1 || normalized.Rules[0].UI.Show[0] != "watermark" {
		t.Fatalf("normalized rule UI = %#v, error = %v", normalized.Rules[0].UI, err)
	}
	contract.Rules[0].UI.Hide = []string{"watermark"}
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("overlapping rule UI show and hide fields were accepted")
	}
	contract.Rules[0].UI = VideoModelContractRuleUI{Hide: []string{"duration"}, Disable: []string{"duration"}}
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("overlapping rule UI hide and disable fields were accepted")
	}
	contract.Rules[0].UI = VideoModelContractRuleUI{Hide: []string{"unsupported"}}
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("unsupported rule UI field was accepted")
	}
	contract.Rules[0].UI = VideoModelContractRuleUI{}
	contract.Rules[0].Forbid = []string{"size"}
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("required and forbidden field overlap was accepted")
	}
	contract = DefaultVideoContracts()[0]
	contract.Rules = []VideoModelContractRule{{
		When:    VideoModelContractRuleCondition{Field: "generate_audio", Operator: "present"},
		Require: []string{"reference_image"},
		Limits:  map[string]int{"reference_image": 0},
		Message: "invalid",
	}}
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("required field with a zero limit was accepted")
	}
	contract = DefaultVideoContracts()[0]
	contract.Generation.Selection = "explicit"
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("unsupported explicit mode selection was accepted")
	}
	contract = DefaultVideoContracts()[0]
	duplicate := contract.Generation.Modes[1]
	duplicate.ID = "image-to-video-alternate"
	contract.Generation.Modes[2] = duplicate
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("duplicate inferred mode kind was accepted")
	}
	contract = DefaultVideoContracts()[0]
	contract.Generation.DefaultMode = "image-to-video"
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("non-text default inferred mode was accepted")
	}
	contract = DefaultVideoContracts()[0]
	contract.Generation.Modes[2].Materials.Total.Max = 2
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("total limit below a material category limit was accepted")
	}
	contract = DefaultVideoContracts()[0]
	contract.Generation.Modes[2].Materials.Image.Min = 2
	contract.Generation.Modes[2].Materials.Image.Max = 2
	contract.Generation.Modes[2].Materials.Video.Min = 2
	contract.Generation.Modes[2].Materials.Video.Max = 2
	contract.Generation.Modes[2].Materials.Audio.Max = 0
	contract.Generation.Modes[2].Materials.Total.Max = 3
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("total limit below the sum of material minimums was accepted")
	}
	contract = DefaultVideoContracts()[0]
	contract.Generation.Modes[2].RequestValue = contract.Generation.Modes[1].ID
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("ambiguous generation mode selector was accepted")
	}
}

func TestVideoContractToggleAudioRequiresRequestField(t *testing.T) {
	contract := DefaultVideoContracts()[0]
	contract.Capability.AudioControl = "toggle"
	contract.Request.GenerateAudioField = ""
	if _, err := NormalizeVideoModelContract(contract); err == nil {
		t.Fatal("toggle audio contract without request field was accepted")
	}
	contract.Request.GenerateAudioField = "generate_audio"
	if _, err := NormalizeVideoModelContract(contract); err != nil {
		t.Fatalf("toggle audio contract with request field was rejected: %v", err)
	}
}
