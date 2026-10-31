package httpapi

import (
	"strings"

	"chatgpt2api/internal/service"
)

// settleCanvasAgentRevision marks a run left "running" by a service restart as interrupted
// before a project mutation. It returns the revision the mutation must expect: the caller's
// revision is only replaced when it matched the state that was settled.
func (a *App) settleCanvasAgentRevision(identity service.Identity, projectID string, revision int64) int64 {
	if a.canvasAgent == nil {
		return revision
	}
	projectID = strings.TrimSpace(projectID)
	before, err := a.canvas.Project(identityScope(identity), projectID)
	if err != nil || before.AgentRun == nil || before.AgentRun.Status != "running" || before.Revision != revision {
		return revision
	}
	after, err := a.canvasAgent.Snapshot(identity, projectID)
	if err != nil || after.AgentRun == nil || after.AgentRun.Status == "running" {
		return revision
	}
	return after.Revision
}
