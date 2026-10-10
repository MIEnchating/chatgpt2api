package httpapi

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"time"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/service"
	"chatgpt2api/internal/translation"
	"chatgpt2api/internal/util"
)

const relayTranslationSourceKey = "relay_parameter_translation"
const relayTaskCredentialKey = "relay_task_credential"

// The private Go type cannot be supplied through a JSON or multipart request.
// It freezes the selected endpoint, credentials and rules before a task queues.
type frozenTaskCredential struct{ credential relayCredential }

func (a *App) freezeRelayCredentialForTask(ctx context.Context, identity service.Identity, body map[string]any) error {
	delete(body, relayTaskCredentialKey)
	credential, err := a.relayCredentialForIdentitySelection(ctx, identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body))
	if err != nil {
		return err
	}
	if !credential.Custom {
		credential.ParameterTranslation = a.config.RelayParameterTranslation()
	}
	if _, err := translation.Models(credential.ParameterTranslation); err != nil {
		return err
	}
	body[relayTaskCredentialKey] = frozenTaskCredential{credential}
	return nil
}
func (a *App) relayCredentialForTask(ctx context.Context, identity service.Identity, body map[string]any) (relayCredential, error) {
	if frozen, ok := body[relayTaskCredentialKey].(frozenTaskCredential); ok {
		return frozen.credential, nil
	}
	credential, err := a.relayCredentialForIdentitySelection(ctx, identity, selectedRelayTokenGroupFromPayload(body), selectedRelayTokenNameFromPayload(body))
	if err == nil && !credential.Custom {
		credential.ParameterTranslation = a.config.RelayParameterTranslation()
	}
	return credential, err
}

func (a *App) relayTranslatedMedia(ctx context.Context, payload map[string]any, images []protocol.UploadedImage, kind string) (map[string]any, bool, error) {
	source := util.Clean(payload[relayTranslationSourceKey])
	if source == "" {
		return nil, false, nil
	}
	ctx = relayContextForPayload(ctx, payload)
	engine, err := translation.New(translation.Channel{Source: source, BaseURL: a.relayBaseURLFromPayload(payload)}, util.Clean(payload["model"]), relayAPIKeyFromPayload(payload), translationVariables(payload, images, kind), a.relayHTTPClientForContext(ctx))
	if err != nil {
		return nil, true, protocol.HTTPError{Status: http.StatusBadRequest, Message: err.Error()}
	}
	if engine == nil {
		return nil, false, nil
	}
	progress := func(value int) {
		if callback, ok := payload[service.MediaTaskProgressCallbackPayloadKey].(func(int)); ok {
			callback(value)
		}
	}
	progress(0)
	result, err := engine.Execute(ctx, kind, progress)
	if err != nil {
		return nil, true, protocol.HTTPError{Status: http.StatusBadGateway, Message: err.Error()}
	}
	data := make([]map[string]any, 0, len(result.URLs))
	for _, value := range result.URLs {
		if kind == "audio" && strings.HasPrefix(value, "data:") {
			parts := strings.SplitN(value, ",", 2)
			if len(parts) != 2 {
				return nil, true, fmt.Errorf("音频数据格式无效")
			}
			raw, err := base64.StdEncoding.DecodeString(parts[1])
			if err != nil {
				return nil, true, err
			}
			format := util.Clean(payload["response_format"])
			for _, candidate := range []struct{ mime, format string }{{"audio/wav", "wav"}, {"audio/x-wav", "wav"}, {"audio/ogg", "opus"}, {"audio/opus", "opus"}, {"audio/flac", "flac"}, {"audio/aac", "aac"}, {"audio/mpeg", "mp3"}} {
				if strings.Contains(parts[0], candidate.mime) {
					format = candidate.format
					break
				}
			}
			if format == "" {
				format = "mp3"
			}
			stored, err := a.generatedAudioResult(raw, format)
			if err != nil {
				return nil, true, err
			}
			data = append(data, util.AsMapSlice(stored["data"])...)
			continue
		}
		item := map[string]any{"url": value}
		if kind != "image" {
			item["type"] = kind
			item[kind+"_url"] = value
		}
		data = append(data, item)
	}
	return map[string]any{"created": time.Now().Unix(), "model": payload["model"], "data": data, "output_type": kind}, true, nil
}

func translationVariables(p map[string]any, images []protocol.UploadedImage, kind string) map[string]any {
	out := map[string]any{}
	for key, field := range map[string]string{"model": "model", "prompt": "prompt", "size": "size", "quality": "quality", "count": "n", "resolution": "resolution", "seconds": "seconds", "mode": "generation_mode", "negativePrompt": "negative_prompt", "generateAudio": "generate_audio", "watermark": "watermark", "firstFrame": "first_frame_url", "lastFrame": "last_frame_url", "voice": "voice", "audioFormat": "response_format", "speed": "speed", "instructions": "instructions"} {
		if value, ok := p[field]; ok {
			out[key] = value
		}
	}
	out["aspectRatio"] = firstNonEmpty(util.Clean(p["aspect_ratio"]), util.Clean(p["ratio"]), util.Clean(p["size"]))
	out["images"] = util.AsStringSlice(p["reference_image_urls"])
	if len(images) > 0 {
		out["images"] = imageReferenceURLs(images)
	}
	out["videos"] = util.AsStringSlice(p["reference_video_urls"])
	out["audios"] = util.AsStringSlice(p["reference_audio_urls"])
	if kind == "audio" {
		out["prompt"] = firstNonEmpty(util.Clean(p["input"]), util.Clean(p["prompt"]))
	}
	return out
}
