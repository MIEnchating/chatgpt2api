package service

import (
	"encoding/json"
	"strings"
)

type CanvasScriptProject struct {
	Step      int                 `json:"step"`
	Confirmed bool                `json:"confirmed"`
	Shots     []CanvasScriptShot  `json:"shots"`
	Assets    []CanvasScriptAsset `json:"assets"`
}

type CanvasScriptShot struct {
	ID           string                 `json:"id"`
	Seconds      int                    `json:"seconds"`
	Description  string                 `json:"description"`
	Framing      string                 `json:"framing"`
	Lighting     string                 `json:"lighting"`
	Dialogue     []CanvasScriptDialogue `json:"dialogue"`
	Sound        string                 `json:"sound"`
	Camera       string                 `json:"camera"`
	AssetIDs     []string               `json:"asset_ids"`
	ImagePrompt  string                 `json:"image_prompt"`
	VideoPrompt  string                 `json:"video_prompt"`
	Color        string                 `json:"color"`
	SourceNodeID string                 `json:"source_node_id,omitempty"`
	ImageNodeID  string                 `json:"image_node_id,omitempty"`
	VideoNodeID  string                 `json:"video_node_id,omitempty"`
}

type CanvasScriptAsset struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	Description string `json:"description"`
	ImageNodeID string `json:"image_node_id"`
}

type CanvasScriptDialogue struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	AssetID string `json:"asset_id"`
	Text    string `json:"text"`
}

type CanvasScriptOperation struct {
	Kind    string   `json:"kind"`
	ShotIDs []string `json:"shot_ids"`
}

func validateCanvasScript(node CanvasNode) error {
	project := node.ScriptProject
	if project == nil {
		if node.ScriptOperation != nil {
			return invalidCanvasDocument("script operation requires a project")
		}
		return nil
	}
	if node.Type != "script" || project.Step < 0 || project.Step > 2 || len(project.Shots) > 200 || len(project.Assets) > 120 {
		return invalidCanvasDocument("script project is invalid")
	}
	encoded, err := json.Marshal(project)
	if err != nil || len(encoded) > 512<<10 {
		return invalidCanvasDocument("script project is too large")
	}
	assets := make(map[string]string, len(project.Assets))
	for _, asset := range project.Assets {
		if asset.ID == "" || len(asset.ID) > 128 || len(asset.Name) > 512 || len(asset.Description) > 60000 || len(asset.ImageNodeID) > 128 {
			return invalidCanvasDocument("script asset is invalid")
		}
		if _, exists := assets[asset.ID]; exists {
			return invalidCanvasDocument("script asset ids must be unique")
		}
		if asset.Kind != "character" && asset.Kind != "scene" && asset.Kind != "prop" {
			return invalidCanvasDocument("script asset kind is invalid")
		}
		assets[asset.ID] = asset.Kind
	}
	shots := make(map[string]bool, len(project.Shots))
	for _, shot := range project.Shots {
		if shot.ID == "" || len(shot.ID) > 128 || shots[shot.ID] || shot.Seconds < 1 || shot.Seconds > 60 || len(shot.Dialogue) > 100 || len(shot.AssetIDs) > 120 {
			return invalidCanvasDocument("script shot is invalid")
		}
		shots[shot.ID] = true
		if len(shot.SourceNodeID) > 128 || len(shot.ImageNodeID) > 128 || len(shot.VideoNodeID) > 128 {
			return invalidCanvasDocument("script shot node reference is invalid")
		}
		if !strings.Contains("|#ef6b68|#f5c542|#52c99b|#4bb7ef|#bdbdbd|", "|"+shot.Color+"|") && shot.Color != "" {
			return invalidCanvasDocument("script shot color is invalid")
		}
		for _, value := range []string{shot.Description, shot.Framing, shot.Lighting, shot.Sound, shot.Camera, shot.ImagePrompt, shot.VideoPrompt} {
			if len(value) > 60000 {
				return invalidCanvasDocument("script shot text is too large")
			}
		}
		seenAssets := make(map[string]bool, len(shot.AssetIDs))
		for _, id := range shot.AssetIDs {
			if assets[id] == "" || seenAssets[id] {
				return invalidCanvasDocument("script shot asset reference is invalid")
			}
			seenAssets[id] = true
		}
		lines := make(map[string]bool, len(shot.Dialogue))
		for _, line := range shot.Dialogue {
			if line.ID == "" || len(line.ID) > 128 || lines[line.ID] || len(line.Text) > 60000 || line.Kind != "dialogue" && line.Kind != "narration" || line.AssetID != "" && assets[line.AssetID] != "character" {
				return invalidCanvasDocument("script dialogue is invalid")
			}
			lines[line.ID] = true
		}
	}
	if project.Confirmed && len(project.Shots) == 0 {
		return invalidCanvasDocument("confirmed script requires shots")
	}
	if operation := node.ScriptOperation; operation != nil {
		if operation.Kind != "script" && operation.Kind != "prompts" || len(operation.ShotIDs) > 200 || operation.Kind == "prompts" && len(operation.ShotIDs) == 0 {
			return invalidCanvasDocument("script operation is invalid")
		}
		seen := make(map[string]bool, len(operation.ShotIDs))
		for _, id := range operation.ShotIDs {
			if !shots[id] || seen[id] {
				return invalidCanvasDocument("script operation shot is invalid")
			}
			seen[id] = true
		}
	}
	return nil
}
