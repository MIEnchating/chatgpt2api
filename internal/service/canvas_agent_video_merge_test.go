package service

import (
	"context"
	"slices"
	"strings"
	"testing"
)

func scriptVideoMergeWorker(t *testing.T) *canvasAgentWorker {
	t.Helper()
	w := parallelAgentWorker(t, nil)
	w.doc.Nodes = []CanvasNode{
		{ID: "script", Type: "script", Width: 550, Height: 600, Title: "Short film", ScriptProject: &CanvasScriptProject{Confirmed: true, Shots: []CanvasScriptShot{{ID: "first", Seconds: 5, VideoNodeID: "b"}, {ID: "second", Seconds: 5, VideoNodeID: "a"}}, Assets: []CanvasScriptAsset{}}},
		{ID: "a", Type: "video", Width: 320, Height: 240, URL: "/a.mp4", GenerationVideoModel: "test", GenerationVideoSeconds: 5, GenerationStatus: "success"},
		{ID: "b", Type: "video", Width: 320, Height: 240, URL: "/b.mp4", GenerationVideoModel: "test", GenerationVideoSeconds: 5, GenerationStatus: "success"},
	}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	return w
}

func TestCanvasAgentMergeScriptVideosUsesShotOrderAndReusesResult(t *testing.T) {
	w := scriptVideoMergeWorker(t)
	calls := 0
	w.service.SetVideoMerger(func(_ context.Context, _ Identity, nodes []CanvasNode, options CanvasVideoMergeOptions) (CanvasMergedVideo, error) {
		calls++
		if !slices.Equal([]string{nodes[0].ID, nodes[1].ID}, []string{"b", "a"}) {
			t.Fatal("merge used canvas order instead of script order")
		}
		return CanvasMergedVideo{URL: "/movie.mp4", StorageKey: "server:movie", Bytes: 2000, MergedVideoInfo: MergedVideoInfo{Width: 320, Height: 240, Duration: 10}}, nil
	})
	result, err := w.tool(map[string]any{"name": "merge_script_videos", "arguments": map[string]any{"scriptNodeId": "script"}})
	if err != nil || result["ok"] != true || calls != 1 {
		t.Fatalf("merge failed: %v %v", result, err)
	}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	mergedID := result["nodeId"].(string)
	if w.node("script").ScriptProject.MergedVideoNodeID != mergedID || len(w.doc.Nodes) != 4 || w.node(mergedID).GenerationStatus != "success" || w.node("a").URL != "/a.mp4" {
		t.Fatal("merged node or original clips were lost")
	}
	for _, source := range []string{"b", "a"} {
		if !slices.ContainsFunc(w.doc.Connections, func(edge CanvasConnection) bool { return edge.FromNodeID == source && edge.ToNodeID == mergedID }) {
			t.Fatal("merged result lost a source connection")
		}
	}
	result, err = w.mergeScriptVideos("script")
	if err != nil || result["reused"] != true || calls != 1 || result["nodeId"] != mergedID {
		t.Fatal("same source clips triggered a duplicate merge", result, err)
	}
}

func TestCanvasAgentMergeDeliveryReportsMeasuredMediaAndCurrentReviews(t *testing.T) {
	w := scriptVideoMergeWorker(t)
	calls := 0
	w.service.SetVideoMerger(func(context.Context, Identity, []CanvasNode, CanvasVideoMergeOptions) (CanvasMergedVideo, error) {
		calls++
		return CanvasMergedVideo{URL: "/movie.mp4", MergedVideoInfo: MergedVideoInfo{Width: 320, Height: 240, Duration: 10, HasAudio: true}}, nil
	})
	result, err := w.mergeScriptVideos("script")
	if err != nil || result["ok"] != true {
		t.Fatal(result, err)
	}
	metadata, ok := result["mediaMetadata"].(*CanvasMediaMetadata)
	if !ok || metadata.DurationMS != 10000 || metadata.Width != 320 || metadata.Height != 240 || metadata.HasAudio == nil || !*metadata.HasAudio {
		t.Fatalf("measured merged media missing from delivery: %v", result)
	}
	if review := agentMap(result["qualityReview"]); review["status"] != "unchecked" || review["uncheckedShots"] != 2 || review["passedShots"] != 0 {
		t.Fatalf("successful merge was treated as quality approval: %v", review)
	}
	movieID := result["nodeId"]
	project := w.node("script").ScriptProject
	project.Shots[0].QualityReview = &CanvasScriptQualityReview{MediaURL: "/b.mp4", Continuity: "passed", Dialogue: "passed", Speaker: "passed", LipSync: "passed", TextOnScreen: "needs_fix", Notes: "Unrequested subtitles"}
	project.Shots[1].QualityReview = &CanvasScriptQualityReview{MediaURL: "/old-a.mp4", Continuity: "passed", Dialogue: "passed", Speaker: "passed", LipSync: "passed", Notes: "Review of the old clip"}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	result, err = w.mergeScriptVideos("script")
	if err != nil || result["nodeId"] != movieID || result["reused"] != true || calls != 1 {
		t.Fatalf("review change remerged the video: %v %v calls=%d", result, err, calls)
	}
	review := agentMap(result["qualityReview"])
	if review["status"] != "needs_fix" || review["passedShots"] != 0 || review["needsFixShots"] != 1 || review["uncheckedShots"] != 1 {
		t.Fatalf("current and stale review counts are incorrect: %v", review)
	}
	if text := agentJSON(review); !strings.Contains(text, "Unrequested subtitles") || strings.Contains(text, "Review of the old clip") || strings.Contains(text, "/b.mp4") {
		t.Fatalf("current review omitted or stale review/media URL exposed: %s", text)
	}
	project = w.node("script").ScriptProject
	for i := range project.Shots {
		shot := &project.Shots[i]
		shot.QualityReview = &CanvasScriptQualityReview{MediaURL: w.node(shot.VideoNodeID).URL, Continuity: "passed", Dialogue: "passed", Speaker: "passed", LipSync: "passed"}
	}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	result, err = w.mergeScriptVideos("script")
	if review := agentMap(result["qualityReview"]); err != nil || review["status"] != "unchecked" || review["uncheckedShots"] != 2 || calls != 1 {
		t.Fatalf("legacy reviews incorrectly certify text on screen: %v %v", result, err)
	}
	for i := range w.node("script").ScriptProject.Shots {
		w.node("script").ScriptProject.Shots[i].QualityReview.TextOnScreen = "passed"
	}
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	result, err = w.mergeScriptVideos("script")
	if review := agentMap(result["qualityReview"]); err != nil || review["status"] != "passed" || review["passedShots"] != 2 || calls != 1 {
		t.Fatalf("actual current reviews not reflected: %v %v", result, err)
	}
	movie := w.node(movieID.(string))
	movie.MediaMetadata = nil
	movie.GenerationVideoSeconds = 60
	movie.MediaProbeError = "Media inspection unavailable"
	movie.MediaSilentClips = 1
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	result, err = w.mergeScriptVideos("script")
	if err != nil || result["mediaMetadata"] != nil || result["durationSeconds"] != nil || result["mediaProbeError"] != "Media inspection unavailable" || result["mediaSilentClips"] != 1 || calls != 1 {
		t.Fatalf("delivery hid probe/silent-clip warnings or replaced measurements with request values: %v %v", result, err)
	}
}

func TestCanvasAgentMergeRejectsMissingAndChangingClips(t *testing.T) {
	for _, change := range []string{"missing", "loading", "error", "reordered"} {
		t.Run(change, func(t *testing.T) {
			w := scriptVideoMergeWorker(t)
			calls := 0
			w.service.SetVideoMerger(func(_ context.Context, _ Identity, _ []CanvasNode, _ CanvasVideoMergeOptions) (CanvasMergedVideo, error) {
				calls++
				current, err := w.service.canvas.Project(w.identity.ID, w.doc.ID)
				if err != nil {
					return CanvasMergedVideo{}, err
				}
				slices.Reverse(current.Nodes[0].ScriptProject.Shots)
				_, err = w.service.canvas.SaveAtRevision(w.identity.ID, current)
				return CanvasMergedVideo{URL: "/movie.mp4", MergedVideoInfo: MergedVideoInfo{Width: 320, Height: 240, Duration: 10}}, err
			})
			switch change {
			case "missing":
				w.node("script").ScriptProject.Shots[0].VideoNodeID = "deleted"
			case "loading", "error":
				w.node("b").GenerationStatus = change
			}
			result, err := w.mergeScriptVideos("script")
			if err != nil || result["ok"] == true || len(w.doc.Nodes) != 3 {
				t.Fatal("partial or stale composition was added to canvas", result, err)
			}
			if change == "reordered" && (result["code"] != "canvas_changed" || calls != 1) || change != "reordered" && calls != 0 {
				t.Fatal("missing clips were processed or concurrent reorder was ignored", result, calls)
			}
		})
	}
}

func TestCanvasAgentMergeDiscardsStaleMovieAtFinalSave(t *testing.T) {
	for _, change := range []string{"reorder", "replace", "delete-script", "edit-dialogue"} {
		t.Run(change, func(t *testing.T) {
			w := scriptVideoMergeWorker(t)
			base := cloneCanvasAgentDocument(w.doc)
			edited := cloneCanvasAgentDocument(base)
			edited.Nodes = append(edited.Nodes, CanvasNode{ID: "movie", Type: "video", URL: "/movie.mp4", GenerationStatus: "success"})
			_, fingerprint, err := w.scriptMergeSources("script")
			if err != nil {
				t.Fatal(err)
			}
			edited.Nodes[0].ScriptProject.MergedVideoNodeID = "movie"
			edited.Nodes[0].ScriptProject.MergedVideoFingerprint = fingerprint
			current := cloneCanvasAgentDocument(base)
			switch change {
			case "reorder":
				slices.Reverse(current.Nodes[0].ScriptProject.Shots)
			case "replace":
				current.Nodes[1].URL = "/replacement.mp4"
			case "delete-script":
				current.Nodes = current.Nodes[1:]
			case "edit-dialogue":
				current.Nodes[0].ScriptProject.Shots[0].Description = "Updated dialogue"
			}
			result := mergeCanvasAgentDocument(base, edited, current)
			for _, node := range result.Nodes {
				if node.ID == "movie" || node.ScriptProject != nil && node.ScriptProject.MergedVideoNodeID == "movie" {
					t.Fatal("final concurrent save retained a stale movie")
				}
			}
		})
	}
}

func TestCanvasAgentMergeUsesShotTimingAndAcceptsSingleClip(t *testing.T) {
	w := scriptVideoMergeWorker(t)
	w.node("script").ScriptProject.Shots = w.node("script").ScriptProject.Shots[:1]
	if err := w.save(); err != nil {
		t.Fatal(err)
	}
	_, before, err := w.scriptMergeSources("script")
	if err != nil {
		t.Fatal(err)
	}
	w.node("script").ScriptProject.Shots[0].Seconds = 6
	_, after, err := w.scriptMergeSources("script")
	if err != nil || before == after {
		t.Fatal("timing omitted from delivery identity", err)
	}
	w.node("script").ScriptProject.Shots[0].Seconds = 5
	w.service.SetVideoMerger(func(_ context.Context, _ Identity, nodes []CanvasNode, options CanvasVideoMergeOptions) (CanvasMergedVideo, error) {
		if len(nodes) != 1 || !slices.Equal(options.ShotSeconds, []float64{5}) {
			t.Fatalf("delivery contract: %+v %+v", nodes, options)
		}
		return CanvasMergedVideo{URL: "/single.mp4", MergedVideoInfo: MergedVideoInfo{Width: 320, Height: 240, Duration: 5, HasAudio: true}}, nil
	})
	result, err := w.mergeScriptVideos("script")
	if err != nil || result["ok"] != true {
		t.Fatal(result, err)
	}
	movie := w.node(result["nodeId"].(string))
	if movie.MediaMetadata == nil || movie.MediaMetadata.DurationMS != 5000 || movie.MediaMetadata.HasAudio == nil || !*movie.MediaMetadata.HasAudio || movie.DurationMS != 0 || movie.GenerationVideoSeconds != 0 {
		t.Fatalf("actual metadata mixed with request or processing time: %+v", movie)
	}
}

func TestCanvasMovieFingerprintIgnoresReviewAndPresentationMetadata(t *testing.T) {
	w := scriptVideoMergeWorker(t)
	shot := &w.node("script").ScriptProject.Shots[0]
	shot.Dialogue = []CanvasScriptDialogue{{ID: "line", Kind: "dialogue", Text: "Hello"}}
	_, before, err := w.scriptMergeSources("script")
	if err != nil {
		t.Fatal(err)
	}
	shot.Color = "#ef6b68"
	shot.Dialogue[0].ID = "new-id"
	shot.QualityReview = &CanvasScriptQualityReview{MediaURL: "/b.mp4", Continuity: "passed"}
	_, after, err := w.scriptMergeSources("script")
	if err != nil || before != after {
		t.Fatal("review or presentation changed composition identity", err)
	}
	shot.Dialogue[0].Text = "Different words"
	_, after, err = w.scriptMergeSources("script")
	if err != nil || before == after {
		t.Fatal("dialogue content missing from composition identity", err)
	}
}
