package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"chatgpt2api/internal/util"
)

var errCanvasAgentGoalYielded = errors.New("目标续跑已让出执行机会")

func (w *canvasAgentWorker) admitGoalContinuation(round int) (bool, error) {
	if err := w.ctx.Err(); err != nil {
		return false, err
	}
	if round != w.goalRound+1 || round > w.req.GoalContinuation || w.req.goalRevision == "" || w.readOnly || w.conversation ||
		w.batchFailed || w.finalBlocked || len(w.sdk.Question) > 0 || len(agentMap(w.state["pendingQuestion"])) > 0 ||
		w.req.ModelRequestLimit > 0 && w.modelRequests >= w.req.ModelRequestLimit {
		return false, nil
	}
	run := agentMap(w.session["goalRun"])
	if len(run) > 0 {
		if util.Clean(run["runId"]) != w.req.ID || util.Clean(run["goalRevision"]) != w.req.goalRevision {
			return false, nil
		}
		started, ok := util.StrictInt(run["roundsStarted"])
		maxRounds, maxRoundsOK := util.StrictInt(run["maxRounds"])
		if !ok || !maxRoundsOK || maxRounds != w.req.GoalContinuation || started+1 != round || started >= maxRounds {
			return false, nil
		}
	} else {
		// Older runs have no persisted reservation. Initialize it before the
		// activity save so the first admitted round becomes durable.
		run = map[string]any{
			"runId":         w.req.ID,
			"goalRevision":  w.req.goalRevision,
			"roundsStarted": 0,
			"maxRounds":     w.req.GoalContinuation,
		}
		w.session["goalRun"] = run
	}
	doc, err := w.service.canvas.Project(canvasAgentOwner(w.identity), w.doc.ID)
	if err != nil {
		return false, err
	}
	allowed, err := w.goalContinuationCurrent(doc)
	if err != nil || !allowed {
		return false, err
	}
	run["roundsStarted"] = round
	if err := w.activity(fmt.Sprintf("正在自动继续创作目标（%d/%d）", round, w.req.GoalContinuation)); err != nil {
		return false, err
	}
	if err := w.ctx.Err(); err != nil {
		return false, err
	}
	// The committed save includes queue changes that raced with the initial read.
	allowed, err = w.goalContinuationCurrent(w.doc)
	if err == nil && allowed {
		w.goalRound = round
		w.goalRoundPending = true
	}
	return allowed, err
}

func (w *canvasAgentWorker) goalContinuationCurrent(doc CanvasDocument) (bool, error) {
	if doc.AgentRun == nil || doc.AgentRun.ID != w.req.ID || doc.AgentRun.Status != "running" {
		return false, nil
	}
	_, session, err := agentSession(doc, w.req.SessionID)
	if err != nil {
		return false, err
	}
	queue := agentMap(session["messageQueue"])
	run := agentMap(session["goalRun"])
	if len(run) > 0 && (util.Clean(run["runId"]) != w.req.ID || util.Clean(run["goalRevision"]) != w.req.goalRevision) {
		return false, nil
	}
	if session["engine"] == "codex" || agentJSON(session["goal"]) != w.req.goalRevision || queue["paused"] == true ||
		len(util.AsMapSlice(queue["messages"])) > 0 || len(agentMap(agentMap(session["agentState"])["pendingQuestion"])) > 0 {
		return false, nil
	}
	return true, nil
}

func validCanvasAgentGoal(data json.RawMessage) bool {
	var goal struct {
		Objective string `json:"objective"`
		Status    string `json:"status"`
		Blocker   string `json:"blocker,omitempty"`
		Criteria  []struct {
			ID   string `json:"id"`
			Text string `json:"text"`
			Done *bool  `json:"done"`
		} `json:"criteria"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&goal) != nil || strings.TrimSpace(goal.Objective) == "" || utf8.RuneCountInString(goal.Objective) > 500 ||
		len(goal.Criteria) == 0 || len(goal.Criteria) > 12 || utf8.RuneCountInString(goal.Blocker) > 500 {
		return false
	}
	switch goal.Status {
	case "active", "paused", "complete", "blocked":
		if (goal.Status == "blocked") != (strings.TrimSpace(goal.Blocker) != "") {
			return false
		}
	default:
		return false
	}
	seen := make(map[string]bool, len(goal.Criteria))
	for _, criterion := range goal.Criteria {
		if strings.TrimSpace(criterion.ID) == "" || len(criterion.ID) > 128 || seen[criterion.ID] ||
			strings.TrimSpace(criterion.Text) == "" || utf8.RuneCountInString(criterion.Text) > 200 || criterion.Done == nil ||
			goal.Status == "complete" && !*criterion.Done {
			return false
		}
		seen[criterion.ID] = true
	}
	return true
}
