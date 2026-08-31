package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

const (
	maxGeneratedAudioBytes    = 100 << 20
	maxCloneAudioBase64Length = 10 << 20
)

func validateAudioGenerationPayload(payload map[string]any) error {
	model := strings.TrimSpace(util.Clean(payload["model"]))
	input := firstNonEmpty(util.Clean(payload["input"]), util.Clean(payload["prompt"]))
	if input == "" || len([]rune(input)) > 12000 {
		return fmt.Errorf("音频文本不能为空且不能超过 12000 个字符")
	}
	payload["model"] = model
	payload["input"] = input
	payload["prompt"] = input
	protocolName := audioProtocolForModel(model)
	payload["audio_protocol"] = protocolName

	switch protocolName {
	case "glm":
		if len([]rune(input)) > 1024 {
			return fmt.Errorf("GLM-TTS 文本不能超过 1024 个字符")
		}
		voice := firstNonEmpty(util.Clean(payload["voice"]), "tongtong")
		if !audioStringIn(voice, "tongtong", "chuichui", "xiaochen", "jam", "kazi", "douji", "luodo") {
			return fmt.Errorf("GLM-TTS 声音无效")
		}
		format := strings.ToLower(firstNonEmpty(util.Clean(payload["response_format"]), "wav"))
		if !audioStringIn(format, "wav", "pcm") {
			return fmt.Errorf("GLM-TTS 格式必须是 wav 或 pcm")
		}
		speed, err := normalizedAudioRequestSpeed(payload["speed"], 1, 0.5, 2)
		if err != nil {
			return fmt.Errorf("GLM-TTS 语速必须在 0.5 到 2 之间")
		}
		payload["voice"], payload["response_format"], payload["speed"] = voice, format, speed
	case "grok":
		voiceID := firstNonEmpty(util.Clean(payload["voice_id"]), "eve")
		if len(voiceID) > 256 {
			return fmt.Errorf("Grok TTS 声音 ID 无效")
		}
		language := firstNonEmpty(util.Clean(payload["language"]), "auto")
		if !audioStringIn(language, "auto", "en", "zh", "ja", "ko", "fr", "de", "hi", "id", "it", "ru", "tr", "vi", "bn", "pt-BR", "pt-PT", "es-MX", "es-ES", "ar-EG", "ar-SA", "ar-AE") {
			return fmt.Errorf("Grok TTS 语言无效")
		}
		outputFormat := util.StringMap(payload["output_format"])
		codec := strings.ToLower(firstNonEmpty(util.Clean(outputFormat["codec"]), "mp3"))
		if !audioStringIn(codec, "mp3", "wav") {
			return fmt.Errorf("Grok TTS 格式必须是 mp3 或 wav")
		}
		speed, err := normalizedAudioRequestSpeed(payload["speed"], 1, 0.7, 1.5)
		if err != nil {
			return fmt.Errorf("Grok TTS 语速必须在 0.7 到 1.5 之间")
		}
		payload["voice_id"], payload["language"], payload["output_format"], payload["speed"] = voiceID, language, map[string]any{"codec": codec}, speed
	case "mimo-preset", "mimo-design", "mimo-clone":
		format := strings.ToLower(firstNonEmpty(util.Clean(payload["response_format"]), "wav"))
		if !audioStringIn(format, "wav", "mp3") {
			return fmt.Errorf("MiMo TTS 格式必须是 wav 或 mp3")
		}
		payload["response_format"] = format
		if protocolName == "mimo-preset" {
			voice := firstNonEmpty(util.Clean(payload["voice"]), "冰糖")
			if !audioStringIn(voice, "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean") {
				return fmt.Errorf("MiMo TTS 声音无效")
			}
			payload["voice"] = voice
		}
		if protocolName == "mimo-design" {
			description := util.Clean(payload["mimo_voice_design_prompt"])
			if description == "" || len([]rune(description)) > 12000 {
				return fmt.Errorf("请填写有效的音色描述")
			}
			payload["mimo_voice_design_prompt"] = description
		}
		if protocolName == "mimo-clone" {
			cloneAudio := util.Clean(payload["mimo_voice_clone_audio"])
			if err := validateMiMoCloneAudioDataURL(cloneAudio); err != nil {
				return err
			}
			payload["mimo_voice_clone_audio"] = cloneAudio
		}
		if instructions := util.Clean(payload["instructions"]); len([]rune(instructions)) > 12000 {
			return fmt.Errorf("声音指令不能超过 12000 个字符")
		} else if instructions != "" {
			payload["instructions"] = instructions
		}
	case "gemini":
		voice, err := validateGeminiAudioRequest(payload, input)
		if err != nil {
			return err
		}
		payload["generation_audio_gemini_voice"] = voice
	default:
		voice := firstNonEmpty(util.Clean(payload["voice"]), "alloy")
		if !audioStringIn(voice, "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar") {
			return fmt.Errorf("音频声音无效")
		}
		format := strings.ToLower(firstNonEmpty(util.Clean(payload["response_format"]), util.Clean(payload["format"]), "mp3"))
		if !isAudioFormat(format) {
			return fmt.Errorf("音频格式必须是 mp3、wav、opus、aac、flac 或 pcm")
		}
		speed, err := normalizedAudioRequestSpeed(payload["speed"], 1, 0.25, 4)
		if err != nil {
			return fmt.Errorf("音频语速必须在 0.25 到 4 之间")
		}
		payload["voice"], payload["response_format"], payload["speed"] = voice, format, speed
		if instructions := util.Clean(payload["instructions"]); len([]rune(instructions)) > 12000 {
			return fmt.Errorf("声音指令不能超过 12000 个字符")
		} else if instructions != "" {
			payload["instructions"] = instructions
		}
	}
	return nil
}

func audioProtocolForModel(model string) string {
	normalized := strings.ToLower(strings.TrimSpace(model))
	name := normalized
	if index := strings.LastIndex(name, "/"); index >= 0 {
		name = name[index+1:]
	}
	switch {
	case normalized == "glm-tts":
		return "glm"
	case audioStringIn(name, "grok-voice-latest", "grok-voice-think-fast-2.0", "grok-voice-think-fast-1.0"):
		return "grok"
	case normalized == "mimo-v2.5-tts":
		return "mimo-preset"
	case normalized == "mimo-v2.5-tts-voicedesign":
		return "mimo-design"
	case normalized == "mimo-v2.5-tts-voiceclone":
		return "mimo-clone"
	case strings.Contains(normalized, "gemini") && strings.Contains(normalized, "tts"):
		return "gemini"
	default:
		return "openai"
	}
}

func normalizedAudioRequestSpeed(value any, fallback, minimum, maximum float64) (float64, error) {
	text := util.Clean(value)
	if text == "" {
		return fallback, nil
	}
	speed, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(speed) || math.IsInf(speed, 0) || speed < minimum || speed > maximum {
		return 0, fmt.Errorf("invalid audio speed")
	}
	return speed, nil
}

func validateMiMoCloneAudioDataURL(value string) error {
	separator := strings.IndexByte(value, ',')
	if separator < 0 || !audioStringIn(strings.ToLower(value[:separator]), "data:audio/mpeg;base64", "data:audio/mp3;base64", "data:audio/wav;base64", "data:audio/x-wav;base64", "data:audio/wave;base64") {
		return fmt.Errorf("参考音频仅支持 MP3 或 WAV")
	}
	encoded := value[separator+1:]
	if encoded == "" || len(encoded) > maxCloneAudioBase64Length {
		return fmt.Errorf("参考音频 Base64 编码后不能超过 10MB")
	}
	if _, err := base64.StdEncoding.DecodeString(encoded); err != nil {
		return fmt.Errorf("参考音频 Base64 数据无效")
	}
	return nil
}

func validateGeminiAudioRequest(payload map[string]any, input string) (string, error) {
	contents := util.AsMapSlice(payload["contents"])
	if len(contents) != 1 || util.Clean(contents[0]["role"]) != "user" {
		return "", fmt.Errorf("Gemini TTS contents 无效")
	}
	parts := util.AsMapSlice(contents[0]["parts"])
	if len(parts) != 1 || util.Clean(parts[0]["text"]) != input {
		return "", fmt.Errorf("Gemini TTS 文本内容无效")
	}
	config := util.StringMap(payload["generationConfig"])
	modalities := util.AsStringSlice(config["responseModalities"])
	if len(modalities) != 1 || modalities[0] != "AUDIO" {
		return "", fmt.Errorf("Gemini TTS responseModalities 无效")
	}
	speechConfig := util.StringMap(config["speechConfig"])
	voiceConfig := util.StringMap(speechConfig["voiceConfig"])
	prebuilt := util.StringMap(voiceConfig["prebuiltVoiceConfig"])
	voice := util.Clean(prebuilt["voiceName"])
	if !audioStringIn(voice, "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat") {
		return "", fmt.Errorf("Gemini TTS 声音无效")
	}
	return voice, nil
}

func audioStringIn(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}

func (a *App) fetchGrokTTSVoicesAt(ctx context.Context, baseURL, apiKey, model string) ([]map[string]any, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(baseURL), "/") + "/v1/tts/voices?" + url.Values{"model": []string{model}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")
	resp, err := a.relayHTTPClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	payload, err := relayDecodeJSONResponse(resp)
	if err != nil {
		return nil, err
	}
	return normalizeGrokTTSVoices(payload), nil
}

func normalizeGrokTTSVoices(payload map[string]any) []map[string]any {
	voices := util.AsMapSlice(payload["voices"])
	result := make([]map[string]any, 0, len(voices))
	seen := make(map[string]struct{}, len(voices))
	for _, voice := range voices {
		voiceID := strings.TrimSpace(util.Clean(voice["voice_id"]))
		if voiceID == "" || len(voiceID) > 256 {
			continue
		}
		if _, exists := seen[voiceID]; exists {
			continue
		}
		seen[voiceID] = struct{}{}
		item := map[string]any{"voice_id": voiceID}
		if name := strings.TrimSpace(util.Clean(voice["name"])); name != "" && len(name) <= 256 {
			item["name"] = name
		}
		if language := strings.TrimSpace(util.Clean(voice["language"])); language != "" && len(language) <= 64 {
			item["language"] = language
		}
		result = append(result, item)
		if len(result) >= 1000 {
			break
		}
	}
	return result
}

func (a *App) runLoggedAudioTask(ctx context.Context, identity service.Identity, payload map[string]any) (map[string]any, error) {
	start := time.Now()
	payload["owner_id"] = identityScope(identity)
	payload["owner_name"] = identityDisplayName(identity)
	model := firstNonEmpty(util.Clean(payload["model"]), firstString(a.config.AudioModels(), "tts-1"))
	payload["model"] = model
	if err := a.attachRelayAPIKeyForIdentity(ctx, identity, payload); err != nil {
		return nil, err
	}
	result, err := a.relayAudioSpeech(ctx, payload)
	urls := collectURLs(result)
	if err != nil {
		a.logCall(ctx, identity, "音频生成", http.MethodPost, "/api/creation-tasks/audio-generations", model, start, "failed", protocolErrorHTTPStatus(err), err.Error(), urls, payloadAuditCapture(payload))
		return result, err
	}
	a.logCall(ctx, identity, "音频生成", http.MethodPost, "/api/creation-tasks/audio-generations", model, start, "success", http.StatusOK, "", urls, payloadAuditCapture(payload))
	return result, nil
}

func (a *App) relayAudioSpeech(ctx context.Context, payload map[string]any) (map[string]any, error) {
	apiKey := relayAPIKeyFromPayload(payload)
	if apiKey == "" {
		return nil, protocol.HTTPError{Status: http.StatusBadRequest, Message: "upstream API key is required"}
	}
	body, format, protocolName := audioUpstreamBody(payload)
	path := audioUpstreamPath(util.Clean(payload["model"]))
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.relayBaseURLFromPayload(payload)+path, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "audio/*, application/json")
	resp, err := a.relayHTTPClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		result, decodeErr := relayDecodeJSONResponse(resp)
		if decodeErr != nil {
			return result, decodeErr
		}
		return result, protocol.HTTPError{Status: resp.StatusCode, Message: firstNonEmpty(audioJSONErrorMessage(result), "上游音频生成失败")}
	}
	if contentType == "application/json" || strings.HasSuffix(contentType, "+json") {
		return a.storeGeneratedAudioJSON(resp.Body, protocolName, format)
	}
	audio, err := io.ReadAll(io.LimitReader(resp.Body, maxGeneratedAudioBytes+1))
	if err != nil {
		return nil, err
	}
	if len(audio) == 0 || len(audio) > maxGeneratedAudioBytes {
		return nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: "上游音频数据为空或过大"}
	}
	format = audioFormat(contentType, format)
	return a.generatedAudioResult(audio, format)
}

func audioUpstreamBody(payload map[string]any) (map[string]any, string, string) {
	model := util.Clean(payload["model"])
	input := firstNonEmpty(util.Clean(payload["input"]), util.Clean(payload["prompt"]))
	protocolName := audioProtocolForModel(model)
	switch protocolName {
	case "grok":
		outputFormat := util.StringMap(payload["output_format"])
		format := firstNonEmpty(util.Clean(outputFormat["codec"]), "mp3")
		return map[string]any{
			"model": model, "input": input, "voice_id": util.Clean(payload["voice_id"]),
			"language": util.Clean(payload["language"]), "output_format": map[string]any{"codec": format}, "speed": payload["speed"],
		}, format, protocolName
	case "mimo-preset", "mimo-design", "mimo-clone":
		format := firstNonEmpty(util.Clean(payload["response_format"]), "wav")
		messages := make([]map[string]string, 0, 2)
		audio := map[string]any{"format": format}
		instructions := util.Clean(payload["instructions"])
		if protocolName == "mimo-design" {
			messages = append(messages, map[string]string{"role": "user", "content": util.Clean(payload["mimo_voice_design_prompt"])})
		} else if instructions != "" {
			messages = append(messages, map[string]string{"role": "user", "content": instructions})
		}
		if protocolName == "mimo-preset" {
			audio["voice"] = util.Clean(payload["voice"])
		} else if protocolName == "mimo-clone" {
			audio["voice"] = util.Clean(payload["mimo_voice_clone_audio"])
		}
		messages = append(messages, map[string]string{"role": "assistant", "content": input})
		return map[string]any{"model": model, "messages": messages, "audio": audio}, format, protocolName
	case "gemini":
		return map[string]any{
			"contents": payload["contents"], "generationConfig": payload["generationConfig"],
		}, "wav", protocolName
	default:
		format := firstNonEmpty(util.Clean(payload["response_format"]), "mp3")
		body := map[string]any{
			"model": model, "input": input, "voice": util.Clean(payload["voice"]), "response_format": format, "speed": payload["speed"],
		}
		if instructions := util.Clean(payload["instructions"]); instructions != "" {
			body["instructions"] = instructions
		}
		return body, format, protocolName
	}
}

func audioUpstreamPath(model string) string {
	protocolName := audioProtocolForModel(model)
	if protocolName == "mimo-preset" || protocolName == "mimo-design" || protocolName == "mimo-clone" {
		return "/v1/chat/completions"
	}
	if protocolName == "gemini" {
		model = strings.TrimPrefix(strings.TrimSpace(model), "models/")
		return "/v1beta/models/" + url.PathEscape(model) + ":generateContent"
	}
	return "/v1/audio/speech"
}

func (a *App) storeGeneratedAudioJSON(reader io.Reader, protocolName, format string) (map[string]any, error) {
	data, err := io.ReadAll(io.LimitReader(reader, 2*maxGeneratedAudioBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || len(data) > 2*maxGeneratedAudioBytes {
		return nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: "上游音频响应为空或过大"}
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: "上游音频响应不是有效 JSON"}
	}
	var encoded string
	switch protocolName {
	case "gemini":
		encoded = geminiAudioBase64(payload)
	case "mimo-preset", "mimo-design", "mimo-clone":
		encoded = mimoAudioBase64(payload)
	}
	if encoded != "" {
		audio, err := decodeGeneratedAudioBase64(encoded)
		if err != nil {
			return nil, err
		}
		if protocolName == "gemini" {
			audio, err = geminiPCMToWAV(audio)
			if err != nil {
				return nil, err
			}
			format = "wav"
		}
		return a.generatedAudioResult(audio, format)
	}
	if urls := collectURLs(payload); len(urls) > 0 {
		return map[string]any{"output_type": "audio", "data": []map[string]any{{"url": urls[0], "mime_type": audioContentType(format)}}}, nil
	}
	return payload, protocol.HTTPError{Status: http.StatusBadGateway, Message: firstNonEmpty(audioJSONErrorMessage(payload), "上游没有返回音频数据")}
}

func geminiAudioBase64(payload map[string]any) string {
	for _, candidate := range util.AsMapSlice(payload["candidates"]) {
		content := util.StringMap(candidate["content"])
		for _, part := range util.AsMapSlice(content["parts"]) {
			if data := util.Clean(util.StringMap(part["inlineData"])["data"]); data != "" {
				return data
			}
		}
	}
	return ""
}

func mimoAudioBase64(payload map[string]any) string {
	choices := util.AsMapSlice(payload["choices"])
	if len(choices) == 0 {
		return ""
	}
	message := util.StringMap(choices[0]["message"])
	return util.Clean(util.StringMap(message["audio"])["data"])
}

func decodeGeneratedAudioBase64(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if separator := strings.IndexByte(value, ','); strings.HasPrefix(strings.ToLower(value), "data:") && separator >= 0 {
		value = value[separator+1:]
	}
	if value == "" || len(value) > (maxGeneratedAudioBytes*4/3)+8 {
		return nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: "上游音频数据为空或过大"}
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: "上游音频 Base64 数据无效"}
	}
	if len(decoded) == 0 || len(decoded) > maxGeneratedAudioBytes {
		return nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: "上游音频数据为空或过大"}
	}
	return decoded, nil
}

func geminiPCMToWAV(pcm []byte) ([]byte, error) {
	if len(pcm) > maxGeneratedAudioBytes-44 || uint64(len(pcm)) > uint64(^uint32(0))-36 {
		return nil, protocol.HTTPError{Status: http.StatusBadGateway, Message: "Gemini TTS 音频数据过大"}
	}
	wav := make([]byte, 44+len(pcm))
	copy(wav[0:4], "RIFF")
	binary.LittleEndian.PutUint32(wav[4:8], uint32(36+len(pcm)))
	copy(wav[8:16], "WAVEfmt ")
	binary.LittleEndian.PutUint32(wav[16:20], 16)
	binary.LittleEndian.PutUint16(wav[20:22], 1)
	binary.LittleEndian.PutUint16(wav[22:24], 1)
	binary.LittleEndian.PutUint32(wav[24:28], 24000)
	binary.LittleEndian.PutUint32(wav[28:32], 48000)
	binary.LittleEndian.PutUint16(wav[32:34], 2)
	binary.LittleEndian.PutUint16(wav[34:36], 16)
	copy(wav[36:40], "data")
	binary.LittleEndian.PutUint32(wav[40:44], uint32(len(pcm)))
	copy(wav[44:], pcm)
	return wav, nil
}

func audioJSONErrorMessage(payload map[string]any) string {
	if message := util.Clean(payload["message"]); message != "" {
		return message
	}
	if message := util.Clean(util.StringMap(payload["error"])["message"]); message != "" {
		return message
	}
	if reason := util.Clean(util.StringMap(payload["promptFeedback"])["blockReason"]); reason != "" {
		return "Gemini TTS 请求被拦截：" + reason
	}
	return ""
}

func (a *App) generatedAudioResult(audio []byte, format string) (map[string]any, error) {
	name, err := a.storeGeneratedAudio(audio, format)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"output_type": "audio",
		"data": []map[string]any{{
			"url":       "/audios/" + name,
			"mime_type": audioContentType(format),
			"bytes":     len(audio),
		}},
	}, nil
}

func (a *App) storeGeneratedAudio(data []byte, format string) (string, error) {
	var id [12]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	name := "audio-" + hex.EncodeToString(id[:]) + "." + format
	temporary, err := os.CreateTemp(a.audioDir, ".audio-*")
	if err != nil {
		return "", err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return "", err
	}
	if err := temporary.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(temporaryName, filepath.Join(a.audioDir, name)); err != nil {
		return "", err
	}
	return name, nil
}

func audioFormat(contentType, requested string) string {
	if extensions, _ := mime.ExtensionsByType(contentType); len(extensions) > 0 {
		value := strings.TrimPrefix(extensions[0], ".")
		if value == "mpeg" {
			return "mp3"
		}
		if isAudioFormat(value) {
			return value
		}
	}
	requested = strings.ToLower(strings.TrimSpace(requested))
	if isAudioFormat(requested) {
		return requested
	}
	return "mp3"
}

func audioContentType(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "wav":
		return "audio/wav"
	case "opus":
		return "audio/opus"
	case "aac":
		return "audio/aac"
	case "flac":
		return "audio/flac"
	case "pcm":
		return "audio/L16"
	default:
		return "audio/mpeg"
	}
}

func isAudioFormat(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "mp3", "wav", "opus", "aac", "flac", "pcm":
		return true
	default:
		return false
	}
}

func (a *App) handleAudioFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if _, ok := a.requireIdentity(w, r); !ok {
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/audios/")
	if name == "" || strings.ContainsAny(name, `/\\`) || strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(a.audioDir, name)
	if filepath.Dir(path) != filepath.Clean(a.audioDir) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", audioContentType(strings.TrimPrefix(filepath.Ext(name), ".")))
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeFile(w, r, path)
}
