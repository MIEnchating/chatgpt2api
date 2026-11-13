package service

import (
	"context"
	"crypto/sha256"
	"fmt"
	"math"
	"slices"
)

type CanvasMergedVideo struct {
	URL, StorageKey string
	Bytes           int64
	MergedVideoInfo
	Sources []CanvasMediaMetadata
}

type CanvasVideoMergeOptions struct{ ShotSeconds []float64 }

func (s *CanvasAgentService) SetVideoMerger(merge func(context.Context, Identity, []CanvasNode, CanvasVideoMergeOptions) (CanvasMergedVideo, error)) {
	s.videoMerger = merge
}

func (w *canvasAgentWorker) scriptMergeSources(id string) ([]CanvasNode, string, error) {
	return canvasScriptMergeSources(w.doc, id)
}

func canvasScriptMediaReady(node *CanvasNode, kind string, outdated bool) bool {
	return !outdated && node != nil && node.Type == kind && node.URL != "" && node.GenerationStatus != "loading" && node.GenerationStatus != "error"
}

// A script read reports its bound media without repeating prompts or transport URLs.
func canvasScriptProduction(doc CanvasDocument, script CanvasNode) map[string]any {
	project := script.ScriptProject
	nodes := make(map[string]*CanvasNode, len(doc.Nodes))
	for i := range doc.Nodes {
		nodes[doc.Nodes[i].ID] = &doc.Nodes[i]
	}
	mediaState := func(id, kind string, outdated bool) map[string]any {
		node := nodes[id]
		result := map[string]any{"nodeId": id, "ready": canvasScriptMediaReady(node, kind, outdated), "outdated": outdated}
		if node == nil {
			result["status"] = "missing"
			if id == "" {
				result["status"] = "unbound"
			}
			return result
		}
		result["type"], result["status"], result["hasMedia"] = node.Type, node.GenerationStatus, node.URL != ""
		if node.TaskID != "" {
			result["taskId"] = node.TaskID
		}
		if node.GenerationError != "" {
			result["error"] = node.GenerationError
		}
		if node.MediaMetadata != nil {
			result["mediaMetadata"] = node.MediaMetadata
		}
		if node.MediaProbeError != "" {
			result["mediaProbeError"] = node.MediaProbeError
		}
		return result
	}
	shots := make([]map[string]any, 0, len(project.Shots))
	canMerge, measured := len(project.Shots) > 0, len(project.Shots) > 0
	plannedSeconds, actualMS := 0, int64(0)
	for index, shot := range project.Shots {
		video := nodes[shot.VideoNodeID]
		ready := canvasScriptMediaReady(video, "video", shot.VideoOutdated)
		canMerge = canMerge && ready
		plannedSeconds += shot.Seconds
		if ready && video.MediaMetadata != nil && video.MediaMetadata.DurationMS > 0 {
			actualMS += video.MediaMetadata.DurationMS
		} else {
			measured = false
		}
		quality, notes := canvasScriptShotQuality(shot, video)
		shots = append(shots, map[string]any{"shotId": shot.ID, "shotNumber": index + 1, "seconds": shot.Seconds,
			"image": mediaState(shot.ImageNodeID, "image", shot.ImageOutdated), "video": mediaState(shot.VideoNodeID, "video", shot.VideoOutdated),
			"qualityStatus": quality, "qualityNotes": notes})
	}
	result := map[string]any{"totalShots": len(project.Shots), "plannedDurationSeconds": plannedSeconds, "canMerge": canMerge, "shots": shots,
		"movie": mediaState(project.MergedVideoNodeID, "video", project.MergedVideoOutdated)}
	if measured {
		result["actualDurationMS"] = actualMS
	}
	return result
}

func canvasScriptShotQuality(shot CanvasScriptShot, video *CanvasNode) (string, string) {
	review := shot.QualityReview
	if !canvasScriptMediaReady(video, "video", shot.VideoOutdated) || review == nil || review.MediaURL != video.URL {
		return "unchecked", ""
	}
	checks := []string{review.Continuity, review.Dialogue, review.Speaker, review.LipSync, review.TextOnScreen}
	if slices.Contains(checks, "needs_fix") {
		return "needs_fix", review.Notes
	}
	if !slices.ContainsFunc(checks, func(status string) bool { return status != "passed" }) {
		return "passed", review.Notes
	}
	return "unchecked", review.Notes
}

func canvasScriptMergeSources(doc CanvasDocument, id string) ([]CanvasNode, string, error) {
	nodes := make(map[string]*CanvasNode, len(doc.Nodes))
	for i := range doc.Nodes {
		nodes[doc.Nodes[i].ID] = &doc.Nodes[i]
	}
	script := nodes[id]
	if script == nil || script.Type != "script" || script.ScriptProject == nil {
		return nil, "", fmt.Errorf("请指定现有脚本节点")
	}
	project := script.ScriptProject
	if len(project.Shots) == 0 {
		return nil, "", fmt.Errorf("至少需要一个分镜视频才能交付")
	}
	sources := make([]CanvasNode, 0, len(project.Shots))
	identities := make([]map[string]any, 0, len(project.Shots))
	for index, shot := range project.Shots {
		node := nodes[shot.VideoNodeID]
		if !canvasScriptMediaReady(node, "video", shot.VideoOutdated) {
			return nil, "", fmt.Errorf("第 %d 个分镜尚无可用视频，请先完成或恢复原任务；不会跳过镜头或重新提交生成", index+1)
		}
		sources = append(sources, *node)
		dialogue := make([][3]string, 0, len(shot.Dialogue))
		for _, line := range shot.Dialogue {
			dialogue = append(dialogue, [3]string{line.Kind, line.AssetID, line.Text})
		}
		assetIDs := append([]string{}, shot.AssetIDs...)
		identities = append(identities, map[string]any{"id": node.ID, "url": node.URL, "key": node.StorageKey, "shotId": shot.ID, "seconds": shot.Seconds, "description": shot.Description, "framing": shot.Framing, "lighting": shot.Lighting, "sound": shot.Sound, "camera": shot.Camera, "assets": assetIDs, "dialogue": dialogue, "imagePrompt": shot.ImagePrompt, "videoPrompt": shot.VideoPrompt, "imageId": shot.ImageNodeID})
	}
	fingerprint := fmt.Sprintf("%x", sha256.Sum256([]byte(agentJSON(identities))))
	return sources, fingerprint, nil
}

func (w *canvasAgentWorker) mergeScriptVideos(id string) (map[string]any, error) {
	if w.service.videoMerger == nil {
		return agentError("video_merge_unavailable", "服务端视频合并尚未启用"), nil
	}
	sources, fingerprint, err := w.scriptMergeSources(id)
	if err != nil {
		return agentError("script_videos_not_ready", err.Error()), nil
	}
	project := w.node(id).ScriptProject
	if !project.MergedVideoOutdated && project.MergedVideoFingerprint == fingerprint {
		if node := w.node(project.MergedVideoNodeID); node != nil && node.Type == "video" && node.URL != "" && node.GenerationStatus == "success" {
			result := w.scriptVideoDelivery(id, node.ID)
			result["reused"] = true
			return result, nil
		}
	}
	if err := w.save(); err != nil {
		return nil, err
	}
	_, currentFingerprint, err := w.scriptMergeSources(id)
	if err != nil || currentFingerprint != fingerprint {
		return w.canvasChangedResult("分镜顺序或视频来源已变化，未开始合并，请重新核对"), nil
	}
	seconds := make([]float64, len(project.Shots))
	for i, shot := range project.Shots {
		seconds[i] = float64(shot.Seconds)
	}
	merged, err := w.service.videoMerger(w.ctx, w.identity, sources, CanvasVideoMergeOptions{ShotSeconds: seconds})
	if err != nil {
		return nil, err
	}
	if err := w.save(); err != nil {
		return nil, err
	}
	_, currentFingerprint, err = w.scriptMergeSources(id)
	if err != nil || currentFingerprint != fingerprint {
		result := w.canvasChangedResult("合并期间分镜顺序或视频来源已变化，未向画布添加过期成片；已处理的文件保留在素材存储中")
		result["mediaUrl"] = merged.URL
		return result, nil
	}
	if merged.URL == "" || merged.Duration <= 0 || merged.Width < 1 || merged.Height < 1 {
		return agentError("empty_media", "视频合并没有返回有效成片"), nil
	}
	script := w.node(id)
	node := w.newNode("video", firstAgentString(script.Title, "分镜")+"｜成片", "按脚本分镜顺序合并的视频，保留片段原声")
	node.URL, node.StorageKey, node.Bytes = merged.URL, merged.StorageKey, merged.Bytes
	node.NaturalWidth, node.NaturalHeight = merged.Width, merged.Height
	node.GenerationStatus, node.GenerationProgress = "success", 100
	node.GenerationVideoModel, node.GenerationModel = "local-video-merge", "local-video-merge"
	hasAudio := merged.HasAudio
	node.MediaMetadata = &CanvasMediaMetadata{Width: merged.Width, Height: merged.Height, DurationMS: int64(math.Round(merged.Duration * 1000)), HasAudio: &hasAudio}
	node.MediaSilentClips = merged.SilentClips
	node.MimeType = "video/mp4"
	node.ExcludeUpstreamText = true
	node.Width = 480
	node.Height = 480 * float64(merged.Height) / float64(merged.Width)
	if node.Height > 480 {
		node.Width *= 480 / node.Height
		node.Height = 480
	}
	node.X, node.Y = script.X+script.Width+120, script.Y
	for _, source := range sources {
		node.X = math.Max(node.X, source.X+source.Width+120)
	}
	ids := []string{}
	for _, source := range sources {
		if !slices.Contains(ids, source.ID) {
			ids = append(ids, source.ID)
		}
	}
	w.addNode(node, ids)
	project = w.node(id).ScriptProject
	project.MergedVideoNodeID, project.MergedVideoFingerprint, project.MergedVideoOutdated = node.ID, fingerprint, false
	for i, info := range merged.Sources {
		if i < len(sources) {
			if source := w.node(sources[i].ID); source != nil {
				metadata := info
				source.MediaMetadata = &metadata
			}
		}
	}
	if err := w.save(); err != nil {
		return nil, err
	}
	if w.node(node.ID) == nil {
		result := w.canvasChangedResult("最终保存时分镜来源已变化，未添加过期成片；已处理的文件保留在素材存储中")
		result["mediaUrl"] = merged.URL
		return result, nil
	}
	return w.scriptVideoDelivery(id, node.ID), nil
}

// Report current review records independently from successful file production.
func (w *canvasAgentWorker) scriptVideoDelivery(scriptID, movieID string) map[string]any {
	project := w.node(scriptID).ScriptProject
	movie := w.node(movieID)
	passed, needsFix, unchecked := 0, 0, 0
	reviews := []map[string]any{}
	sources := []string{}
	for index, shot := range project.Shots {
		if !slices.Contains(sources, shot.VideoNodeID) {
			sources = append(sources, shot.VideoNodeID)
		}
		status, notes := canvasScriptShotQuality(shot, w.node(shot.VideoNodeID))
		switch status {
		case "passed":
			passed++
		case "needs_fix":
			needsFix++
		default:
			unchecked++
		}
		reviews = append(reviews, map[string]any{"shotId": shot.ID, "shotNumber": index + 1, "status": status, "notes": notes})
	}
	status, message := "unchecked", "成片已保存，可在成片卡播放或下载，原片保留；画面文字、连续性、对白、说话人与口型尚未全部验收"
	if needsFix > 0 {
		status, message = "needs_fix", "成片已保存，可在成片卡播放或下载，原片保留；已有镜头验收记录标记需修复，不能宣称质量通过"
	} else if passed == len(project.Shots) && passed > 0 {
		status, message = "passed", "成片已保存，可在成片卡播放或下载，原片保留；当前各镜头已有完整人工验收通过记录，合并文件未单独进行内容验收"
	}
	result := map[string]any{"ok": true, "nodeId": movie.ID, "sourceNodeIds": sources, "status": "success", "message": message, "qualityReview": map[string]any{"status": status, "totalShots": len(project.Shots), "passedShots": passed, "needsFixShots": needsFix, "uncheckedShots": unchecked, "shots": reviews}}
	if movie.MediaMetadata != nil {
		result["mediaMetadata"] = movie.MediaMetadata
		result["durationSeconds"] = float64(movie.MediaMetadata.DurationMS) / 1000
	}
	if movie.MediaProbeError != "" {
		result["mediaProbeError"] = movie.MediaProbeError
	}
	if movie.MediaSilentClips > 0 {
		result["mediaSilentClips"] = movie.MediaSilentClips
	}
	return result
}

// Check new movies against the final optimistic merge, including late source edits.
func protectCanvasAgentMergedVideos(base, edited, current CanvasDocument, result *CanvasDocument) {
	existing := make(map[string]bool, len(base.Nodes))
	for _, node := range base.Nodes {
		existing[node.ID] = true
	}
	discarded := map[string]bool{}
	for _, script := range edited.Nodes {
		project := script.ScriptProject
		if script.Type != "script" || project == nil || project.MergedVideoNodeID == "" || existing[project.MergedVideoNodeID] {
			continue
		}
		_, fingerprint, err := canvasScriptMergeSources(*result, script.ID)
		if err == nil && fingerprint == project.MergedVideoFingerprint {
			for i := range result.Nodes {
				if node := &result.Nodes[i]; node.ID == script.ID && node.ScriptProject != nil {
					node.ScriptProject.MergedVideoNodeID = project.MergedVideoNodeID
					node.ScriptProject.MergedVideoFingerprint = fingerprint
					break
				}
			}
			continue
		}
		discarded[project.MergedVideoNodeID] = true
		for i := range result.Nodes {
			node := &result.Nodes[i]
			if node.ID != script.ID || node.ScriptProject == nil || node.ScriptProject.MergedVideoNodeID != project.MergedVideoNodeID {
				continue
			}
			node.ScriptProject.MergedVideoNodeID, node.ScriptProject.MergedVideoFingerprint = "", ""
			for _, previous := range current.Nodes {
				if previous.ID == script.ID && previous.ScriptProject != nil {
					node.ScriptProject.MergedVideoNodeID = previous.ScriptProject.MergedVideoNodeID
					node.ScriptProject.MergedVideoFingerprint = previous.ScriptProject.MergedVideoFingerprint
					break
				}
			}
		}
	}
	result.Nodes = slices.DeleteFunc(result.Nodes, func(node CanvasNode) bool { return discarded[node.ID] })
}
