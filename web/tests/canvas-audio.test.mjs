import assert from "node:assert/strict";
import test from "node:test";

import { buildCanvasAudioGenerationRequest, canvasAgentAudioNodeParameters, canvasAudioGenerationReferences, canvasAudioProvider, canvasAudioReferences, canvasAudioResponseFormat, isCanvasAudioFile, resolveCanvasAudioModel } from "../src/app/canvas/canvas-audio.ts";

function node(model, values = {}) {
  return { id: "audio", type: "audio", x: 0, y: 0, width: 340, height: 160, scale_x: 1, scale_y: 1, generation_audio_model: model, ...values };
}

test("canvas uses the explicit default audio model instead of list order", () => {
  assert.equal(resolveCanvasAudioModel("glm-tts", ["gpt-4o-mini-tts", "glm-tts"]), "glm-tts");
  assert.equal(resolveCanvasAudioModel("", ["grok-voice-latest", "glm-tts"]), "grok-voice-latest");
  assert.equal(resolveCanvasAudioModel("", []), "gpt-4o-mini-tts");
});

test("audio node uploads accept every audio MIME type like the reference project", () => {
  assert.equal(isCanvasAudioFile({ name: "voice.ogg", type: "audio/ogg" }), true);
  assert.equal(isCanvasAudioFile({ name: "voice.wav", type: "" }), true);
  assert.equal(isCanvasAudioFile({ name: "cover.png", type: "image/png" }), false);
});

test("audio models select the reference project's provider contracts", () => {
  assert.equal(canvasAudioProvider("glm-tts"), "glm");
  assert.equal(canvasAudioProvider("grok-voice-latest"), "grok");
  assert.equal(canvasAudioProvider("mimo-v2.5-tts-voicedesign"), "mimo-design");
  assert.equal(canvasAudioProvider("gemini-2.5-flash-preview-tts"), "gemini");
  assert.equal(canvasAudioProvider("gpt-4o-mini-tts"), "openai");
});

test("Agent audio nodes persist every provider's native parameters", () => {
  assert.deepEqual(canvasAgentAudioNodeParameters("glm-tts", "chuichui", ""), {
    generation_audio_glm_voice: "chuichui",
    generation_audio_glm_format: "wav",
    generation_audio_glm_speed: 1,
  });
  assert.equal(canvasAgentAudioNodeParameters("grok-voice-latest", "ara", "").generation_audio_grok_voice, "ara");
  assert.equal(canvasAgentAudioNodeParameters("mimo-v2.5-tts", "茉莉", "自然").generation_audio_mimo_voice, "茉莉");
  assert.equal(canvasAgentAudioNodeParameters("mimo-v2.5-tts-voicedesign", "", "低沉旁白").generation_audio_mimo_voice_design_prompt, "低沉旁白");
  assert.equal(canvasAgentAudioNodeParameters("mimo-v2.5-tts-voiceclone", "", "克制", "audio-1").generation_audio_mimo_voice_clone_node_id, "audio-1");
  assert.equal(canvasAgentAudioNodeParameters("gemini-2.5-pro-preview-tts", "Puck", "").generation_audio_gemini_voice, "Puck");
});

test("personal audio defaults are mapped to each provider's native node fields", () => {
  assert.deepEqual(canvasAgentAudioNodeParameters("gpt-4o-mini-tts", "coral", "自然", "", { format: "flac", speed: 1.25 }), {
    generation_audio_voice: "coral",
    generation_audio_format: "flac",
    generation_audio_speed: 1.25,
    generation_audio_instructions: "自然",
  });
  assert.deepEqual(canvasAgentAudioNodeParameters("glm-tts", "chuichui", "", "", { format: "pcm", speed: 1.5 }), {
    generation_audio_glm_voice: "chuichui",
    generation_audio_glm_format: "pcm",
    generation_audio_glm_speed: 1.5,
  });
  assert.equal(canvasAgentAudioNodeParameters("mimo-v2.5-tts", "茉莉", "", "", { format: "mp3", speed: 2 }).generation_audio_mimo_format, "mp3");
});

test("GLM and Grok requests use their native fields and speed ranges", () => {
  assert.deepEqual(buildCanvasAudioGenerationRequest(node("glm-tts", { generation_audio_glm_voice: "chuichui", generation_audio_glm_format: "pcm", generation_audio_glm_speed: 9 }), "你好"), {
    model: "glm-tts", input: "你好", audio_protocol: "glm", voice: "chuichui", response_format: "pcm", speed: 2,
  });
  assert.deepEqual(buildCanvasAudioGenerationRequest(node("grok-voice-latest", { generation_audio_grok_voice: "ara", generation_audio_grok_language: "zh", generation_audio_grok_format: "wav", generation_audio_grok_speed: 0.2 }), "你好"), {
    model: "grok-voice-latest", input: "你好", audio_protocol: "grok", voice_id: "ara", language: "zh", output_format: { codec: "wav" }, speed: 0.7,
  });
});

test("MiMo voice design and clone requests preserve dedicated parameters", () => {
  assert.deepEqual(buildCanvasAudioGenerationRequest(node("mimo-v2.5-tts-voicedesign", { generation_audio_mimo_voice_design_prompt: "年轻女性", generation_audio_mimo_format: "mp3" }), "台词"), {
    model: "mimo-v2.5-tts-voicedesign", input: "台词", audio_protocol: "mimo-design", mimo_voice_design_prompt: "年轻女性", response_format: "mp3",
  });
  assert.deepEqual(buildCanvasAudioGenerationRequest(node("mimo-v2.5-tts-voiceclone", { generation_audio_mimo_format: "wav", generation_audio_instructions: "轻快" }), "台词", "data:audio/wav;base64,YWJj"), {
    model: "mimo-v2.5-tts-voiceclone", input: "台词", audio_protocol: "mimo-clone", mimo_voice_clone_audio: "data:audio/wav;base64,YWJj", instructions: "轻快", response_format: "wav",
  });
});

test("Gemini TTS uses native generateContent speech configuration", () => {
  const request = buildCanvasAudioGenerationRequest(node("gemini-2.5-flash-preview-tts", { generation_audio_gemini_voice: "Puck" }), "Read this");
  assert.deepEqual(request.generationConfig, { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } } });
  assert.equal(canvasAudioResponseFormat(node("gemini-2.5-flash-preview-tts")), "wav");
});

test("MiMo clone references use the same connected-config input rule as generation", () => {
  const nodes = [node("mimo-v2.5-tts-voiceclone"), { ...node("", { id: "voice", url: "/audio/voice.wav", title: "参考声音", mime_type: "audio/wav" }) }, { ...node("", { id: "config", type: "config" }) }];
  const connections = [
    { id: "voice-config", from_node_id: "voice", to_node_id: "config" },
    { id: "audio-config", from_node_id: "audio", to_node_id: "config" },
  ];
  assert.deepEqual(canvasAudioReferences("audio", nodes, connections), [{ nodeID: "voice", title: "参考声音", url: "/audio/voice.wav", mimeType: "audio/wav" }]);
});

test("MiMo clone generation keeps only audio selected by the composer context", () => {
  const nodes = [
    node("mimo-v2.5-tts-voiceclone"),
    { ...node("", { id: "voice-a", url: "/audio/a.wav", title: "声音 A", mime_type: "audio/wav" }) },
    { ...node("", { id: "voice-b", url: "/audio/b.mp3", title: "声音 B", mime_type: "audio/mpeg" }) },
  ];
  const connections = [
    { id: "a-audio", from_node_id: "voice-a", to_node_id: "audio" },
    { id: "b-audio", from_node_id: "voice-b", to_node_id: "audio" },
  ];
  assert.deepEqual(canvasAudioGenerationReferences("audio", nodes, connections, ["/audio/b.mp3"]), [
    { nodeID: "voice-b", title: "声音 B", url: "/audio/b.mp3", mimeType: "audio/mpeg" },
  ]);
});

test("audio references do not recurse through a config output connection", () => {
  const nodes = [node("mimo-v2.5-tts-voiceclone"), { ...node("", { id: "voice", url: "/audio/voice.wav" }) }, { ...node("", { id: "config", type: "config" }) }];
  const connections = [
    { id: "voice-config", from_node_id: "voice", to_node_id: "config" },
    { id: "config-audio", from_node_id: "config", to_node_id: "audio" },
  ];
  assert.deepEqual(canvasAudioReferences("audio", nodes, connections), []);
});
