package service

import "testing"

func TestCanvasAgentToolKinds(t *testing.T) {
	for name, want := range map[string]string{
		"update_plan": "plan", "set_agent_state": "plan",
		"list_workflows": "workflow", "get_workflow": "workflow", "save_workflow": "workflow",
		"create_canvas_workflow": "workflow", "run_canvas_workflow": "workflow", "run_saved_workflow": "workflow",
		"read_skill_file": "file", "get_node": "read", "query_canvas_nodes": "read",
		"generate_image": "generate", "edit_image": "generate", "create_group": "create",
		"update_node": "edit", "delete_connection": "edit", "arrange_nodes": "edit",
	} {
		t.Run(name, func(t *testing.T) {
			if got := agentToolKind(name); got != want {
				t.Fatalf("kind = %q, want %q", got, want)
			}
		})
	}
}
