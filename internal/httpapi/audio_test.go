package httpapi

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestValidateAudioGenerationPayloadProviderContracts(t *testing.T) {
	tests := []struct {
		name     string
		payload  map[string]any
		protocol string
	}{
		{name: "openai", protocol: "openai", payload: map[string]any{"model": "gpt-4o-mini-tts", "input": "hello", "voice": "verse", "response_format": "flac", "speed": 1.25}},
		{name: "glm", protocol: "glm", payload: map[string]any{"model": "glm-tts", "input": "你好", "voice": "chuichui", "response_format": "pcm", "speed": 2}},
		{name: "grok", protocol: "grok", payload: map[string]any{"model": "grok-voice-latest", "input": "你好", "voice_id": "ara", "language": "zh", "output_format": map[string]any{"codec": "wav"}, "speed": 0.7}},
		{name: "mimo preset", protocol: "mimo-preset", payload: map[string]any{"model": "mimo-v2.5-tts", "input": "台词", "voice": "茉莉", "response_format": "mp3", "instructions": "轻快"}},
		{name: "mimo design", protocol: "mimo-design", payload: map[string]any{"model": "mimo-v2.5-tts-voicedesign", "input": "台词", "mimo_voice_design_prompt": "年轻女性", "response_format": "wav"}},
		{name: "mimo clone", protocol: "mimo-clone", payload: map[string]any{"model": "mimo-v2.5-tts-voiceclone", "input": "台词", "mimo_voice_clone_audio": "data:audio/wav;base64,YWJj", "response_format": "wav"}},
		{name: "gemini", protocol: "gemini", payload: geminiAudioRequest("gemini-2.5-flash-preview-tts", "hello", "Kore")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := validateAudioGenerationPayload(test.payload); err != nil {
				t.Fatalf("validateAudioGenerationPayload() error = %v", err)
			}
			if test.payload["audio_protocol"] != test.protocol {
				t.Fatalf("audio protocol = %v, want %q", test.payload["audio_protocol"], test.protocol)
			}
		})
	}
}

func TestValidateAudioGenerationPayloadRejectsProviderSpecificValues(t *testing.T) {
	tests := []map[string]any{
		{"model": "glm-tts", "input": strings.Repeat("字", 1025), "voice": "tongtong", "response_format": "wav", "speed": 1},
		{"model": "glm-tts", "input": "hello", "voice": "tongtong", "response_format": "mp3", "speed": 1},
		{"model": "grok-voice-latest", "input": "hello", "voice_id": "eve", "language": "xx", "output_format": map[string]any{"codec": "mp3"}, "speed": 1},
		{"model": "grok-voice-latest", "input": "hello", "voice_id": "eve", "language": "auto", "output_format": map[string]any{"codec": "mp3"}, "speed": 1.6},
		{"model": "mimo-v2.5-tts-voicedesign", "input": "hello", "mimo_voice_design_prompt": "", "response_format": "wav"},
		{"model": "mimo-v2.5-tts-voiceclone", "input": "hello", "mimo_voice_clone_audio": "data:audio/ogg;base64,YWJj", "response_format": "wav"},
		geminiAudioRequest("gemini-2.5-flash-preview-tts", "hello", "Unknown"),
	}
	for _, payload := range tests {
		if err := validateAudioGenerationPayload(payload); err == nil {
			t.Fatalf("validateAudioGenerationPayload(%#v) succeeded", payload)
		}
	}
}

func TestAudioUpstreamBodyPreservesProviderProtocol(t *testing.T) {
	grok := map[string]any{"model": "grok-voice-latest", "input": "hello", "voice_id": "ara", "language": "en", "output_format": map[string]any{"codec": "wav"}, "speed": 1.2}
	body, format, protocolName := audioUpstreamBody(grok)
	if protocolName != "grok" || format != "wav" || body["voice_id"] != "ara" || body["language"] != "en" || !reflect.DeepEqual(body["output_format"], map[string]any{"codec": "wav"}) {
		t.Fatalf("Grok upstream body = %#v, format=%q protocol=%q", body, format, protocolName)
	}
	if _, exists := body["voice"]; exists {
		t.Fatalf("Grok upstream body was flattened to generic voice: %#v", body)
	}

	mimo := map[string]any{"model": "mimo-v2.5-tts-voiceclone", "input": "hello", "mimo_voice_clone_audio": "data:audio/wav;base64,YWJj", "instructions": "calm", "response_format": "mp3"}
	body, format, protocolName = audioUpstreamBody(mimo)
	messages := body["messages"].([]map[string]string)
	audio := body["audio"].(map[string]any)
	if protocolName != "mimo-clone" || format != "mp3" || len(messages) != 2 || messages[0]["role"] != "user" || messages[0]["content"] != "calm" || messages[1]["role"] != "assistant" || messages[1]["content"] != "hello" || audio["voice"] != mimo["mimo_voice_clone_audio"] || audio["format"] != "mp3" {
		t.Fatalf("MiMo upstream body = %#v, format=%q protocol=%q", body, format, protocolName)
	}

	gemini := geminiAudioRequest("gemini-2.5-flash-preview-tts", "hello", "Kore")
	body, format, protocolName = audioUpstreamBody(gemini)
	if protocolName != "gemini" || format != "wav" || !reflect.DeepEqual(body["contents"], gemini["contents"]) || !reflect.DeepEqual(body["generationConfig"], gemini["generationConfig"]) {
		t.Fatalf("Gemini upstream body = %#v, format=%q protocol=%q", body, format, protocolName)
	}
	if _, exists := body["model"]; exists {
		t.Fatalf("Gemini upstream body contains proxy-only model: %#v", body)
	}
}

func TestAudioUpstreamPathUsesProviderNativeEndpoints(t *testing.T) {
	tests := map[string]string{
		"gpt-4o-mini-tts":                   "/v1/audio/speech",
		"glm-tts":                           "/v1/audio/speech",
		"grok-voice-latest":                 "/v1/audio/speech",
		"mimo-v2.5-tts":                     "/v1/chat/completions",
		"mimo-v2.5-tts-voicedesign":         "/v1/chat/completions",
		"mimo-v2.5-tts-voiceclone":          "/v1/chat/completions",
		"gemini-2.5-flash-preview-tts":      "/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
		"models/gemini-2.5-pro-preview-tts": "/v1beta/models/gemini-2.5-pro-preview-tts:generateContent",
	}
	for model, want := range tests {
		if got := audioUpstreamPath(model); got != want {
			t.Fatalf("audioUpstreamPath(%q) = %q, want %q", model, got, want)
		}
	}
}

func TestNormalizeGrokTTSVoicesFiltersInvalidAndDuplicateEntries(t *testing.T) {
	voices := normalizeGrokTTSVoices(map[string]any{"voices": []any{
		map[string]any{"voice_id": " eve ", "name": " Eve ", "language": " en ", "secret": "hidden"},
		map[string]any{"voice_id": "eve", "name": "duplicate"},
		map[string]any{"voice_id": ""},
		map[string]any{"voice_id": "ara", "name": "Ara"},
	}})
	want := []map[string]any{
		{"voice_id": "eve", "name": "Eve", "language": "en"},
		{"voice_id": "ara", "name": "Ara"},
	}
	if !reflect.DeepEqual(voices, want) {
		t.Fatalf("normalizeGrokTTSVoices() = %#v, want %#v", voices, want)
	}
}

func TestStoreGeneratedAudioJSONDecodesMiMoAndGemini(t *testing.T) {
	app := &App{audioDir: t.TempDir()}
	mimoBytes := []byte("mimo-audio")
	mimoJSON := `{"choices":[{"message":{"audio":{"data":"` + base64.StdEncoding.EncodeToString(mimoBytes) + `"}}}]}`
	result, err := app.storeGeneratedAudioJSON(strings.NewReader(mimoJSON), "mimo-preset", "mp3")
	if err != nil {
		t.Fatalf("storeGeneratedAudioJSON(MiMo) error = %v", err)
	}
	if stored := readGeneratedAudioResult(t, app.audioDir, result); !bytes.Equal(stored, mimoBytes) {
		t.Fatalf("stored MiMo audio = %q", stored)
	}

	pcm := []byte{1, 2, 3, 4}
	geminiJSON := `{"candidates":[{"content":{"parts":[{"inlineData":{"data":"` + base64.StdEncoding.EncodeToString(pcm) + `","mimeType":"audio/L16;codec=pcm;rate=24000"}}]}}]}`
	result, err = app.storeGeneratedAudioJSON(strings.NewReader(geminiJSON), "gemini", "wav")
	if err != nil {
		t.Fatalf("storeGeneratedAudioJSON(Gemini) error = %v", err)
	}
	wav := readGeneratedAudioResult(t, app.audioDir, result)
	if len(wav) != 44+len(pcm) || string(wav[:4]) != "RIFF" || string(wav[8:12]) != "WAVE" || binary.LittleEndian.Uint32(wav[24:28]) != 24000 || !bytes.Equal(wav[44:], pcm) {
		t.Fatalf("stored Gemini WAV is invalid: %v", wav)
	}
}

func geminiAudioRequest(model, input, voice string) map[string]any {
	return map[string]any{
		"model": model, "input": input,
		"contents": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": input}}}},
		"generationConfig": map[string]any{
			"responseModalities": []any{"AUDIO"},
			"speechConfig":       map[string]any{"voiceConfig": map[string]any{"prebuiltVoiceConfig": map[string]any{"voiceName": voice}}},
		},
	}
}

func readGeneratedAudioResult(t *testing.T, audioDir string, result map[string]any) []byte {
	t.Helper()
	data, ok := result["data"].([]map[string]any)
	if !ok || len(data) != 1 {
		t.Fatalf("audio result data = %#v", result["data"])
	}
	name := strings.TrimPrefix(data[0]["url"].(string), "/audios/")
	stored, err := os.ReadFile(filepath.Join(audioDir, name))
	if err != nil {
		t.Fatalf("read generated audio: %v", err)
	}
	return stored
}
