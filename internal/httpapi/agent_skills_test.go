package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
)

func TestAgentSkillsRoutesEnforceIdentityAndRevision(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	_, alice := createPasswordUserSession(t, app, "skill-alice", "", "Alice")
	_, bob := createPasswordUserSession(t, app, "skill-bob", "", "Bob")
	const root = "/api/profile/agent-skills"
	const body = `{"name":"个人写作","content":"Alice private instructions","enabled":true,"owner_id":"bob"}`
	if res := authenticatedProfileRequest(app, "", http.MethodGet, root, ""); res.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous read = %d %s", res.Code, res.Body.String())
	}
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete} {
		if res := authenticatedProfileRequest(app, alice, method, "/api/admin/agent-skills/system-storyboard?revision=1", body); res.Code != http.StatusForbidden {
			t.Fatalf("non-admin %s = %d %s", method, res.Code, res.Body.String())
		}
	}
	res := authenticatedProfileRequest(app, alice, http.MethodPost, root, body)
	if res.Code != http.StatusOK {
		t.Fatalf("create = %d %s", res.Code, res.Body.String())
	}
	var created struct {
		Item service.AgentSkill `json:"item"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil || created.Item.ID == "" {
		t.Fatalf("create payload = %s, %v", res.Body.String(), err)
	}
	path := root + "/" + created.Item.ID
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		res := authenticatedProfileRequest(app, bob, method, path+"?revision=1", `{"name":"overwrite","content":"wrong owner","enabled":true,"revision":1}`)
		if res.Code != http.StatusNotFound {
			t.Fatalf("cross-owner %s = %d %s", method, res.Code, res.Body.String())
		}
	}
	if res := authenticatedProfileRequest(app, bob, http.MethodGet, root, ""); res.Code != http.StatusOK || strings.Contains(res.Body.String(), "Alice private") {
		t.Fatalf("cross-owner list = %d %s", res.Code, res.Body.String())
	}
	updated := `{"name":"新名称","content":"updated","enabled":true,"revision":1}`
	if res := authenticatedProfileRequest(app, alice, http.MethodPut, path, updated); res.Code != http.StatusOK {
		t.Fatalf("update = %d %s", res.Code, res.Body.String())
	}
	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		if res := authenticatedProfileRequest(app, alice, method, path+"?revision=1", updated); res.Code != http.StatusConflict {
			t.Fatalf("stale %s = %d %s", method, res.Code, res.Body.String())
		}
	}
	if res := authenticatedProfileRequest(app, alice, http.MethodDelete, path+"?revision=2", ""); res.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", res.Code, res.Body.String())
	}
	if res := authenticatedProfileRequest(app, alice, http.MethodGet, path, ""); res.Code != http.StatusNotFound {
		t.Fatalf("deleted read = %d %s", res.Code, res.Body.String())
	}
}

func TestAgentSkillsFileRoutesAreLazyAndRespectEnabledState(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	admin := adminSessionToken(t, app)
	_, user := createPasswordUserSession(t, app, "skill-reader", "", "Reader")
	input := service.AgentSkillInput{Name: "System", Content: "Main instructions", Enabled: true, Files: map[string]string{"references/example.md": "EXCLUSIVE_FILE_BODY", "notes.txt": "text"}}
	body, _ := json.Marshal(input)
	res := authenticatedProfileRequest(app, admin, http.MethodPost, "/api/admin/agent-skills", string(body))
	if res.Code != http.StatusOK {
		t.Fatalf("system create = %d %s", res.Code, res.Body.String())
	}
	var created struct {
		Item service.AgentSkill `json:"item"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	path := "/api/profile/agent-skills/" + created.Item.ID
	for _, target := range []string{"/api/profile/agent-skills", path} {
		res := authenticatedProfileRequest(app, user, http.MethodGet, target, "")
		if res.Code != http.StatusOK || strings.Contains(res.Body.String(), "EXCLUSIVE_FILE_BODY") || !strings.Contains(res.Body.String(), `"file_paths"`) {
			t.Fatalf("eager file content = %d %s", res.Code, res.Body.String())
		}
	}
	if res := authenticatedProfileRequest(app, user, http.MethodGet, path+"/file?path=references%2Fexample.md", ""); res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "EXCLUSIVE_FILE_BODY") {
		t.Fatalf("read reference = %d %s", res.Code, res.Body.String())
	}
	for _, filename := range []string{"../example.md", "/etc/file.md", "C:/file.md", "line\n.md"} {
		res := authenticatedProfileRequest(app, user, http.MethodGet, path+"/file?path="+url.QueryEscape(filename), "")
		if res.Code != http.StatusBadRequest {
			t.Fatalf("invalid path %q = %d %s", filename, res.Code, res.Body.String())
		}
	}
	if res := authenticatedProfileRequest(app, user, http.MethodGet, path+"/file?path=missing.md", ""); res.Code != http.StatusNotFound {
		t.Fatalf("missing reference = %d %s", res.Code, res.Body.String())
	}
	input.Enabled, input.Revision = false, created.Item.Revision
	body, _ = json.Marshal(input)
	if res := authenticatedProfileRequest(app, admin, http.MethodPut, "/api/admin/agent-skills/"+created.Item.ID, string(body)); res.Code != http.StatusOK {
		t.Fatalf("disable = %d %s", res.Code, res.Body.String())
	}
	if res := authenticatedProfileRequest(app, user, http.MethodGet, path+"/file?path=references%2Fexample.md", ""); res.Code != http.StatusNotFound {
		t.Fatalf("disabled reference = %d %s", res.Code, res.Body.String())
	}
}

func TestAgentSkillRequestsValidatePayloadAndPreserveEmptySystemList(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	admin := adminSessionToken(t, app)
	for _, test := range []struct {
		body   string
		status int
	}{
		{`{"name":"x","content":"x","enabled":true} {}`, http.StatusBadRequest},
		{`{"name":"x","content":"` + strings.Repeat("x", 128*1024+1) + `"}`, http.StatusBadRequest},
		{strings.Repeat(" ", 4<<20) + `{}`, http.StatusRequestEntityTooLarge},
	} {
		res := authenticatedProfileRequest(app, admin, http.MethodPost, "/api/admin/agent-skills", test.body)
		if res.Code != test.status {
			t.Fatalf("invalid request = %d %s, want %d", res.Code, res.Body.String(), test.status)
		}
	}
	res := authenticatedProfileRequest(app, admin, http.MethodPost, "/api/profile/agent-skills", `{"name":"x","content":"x","files":{"notes.md":"hidden"}}`)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("personal directory = %d %s", res.Code, res.Body.String())
	}
	items, err := app.agentSkills.List("", true)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		res := authenticatedProfileRequest(app, admin, http.MethodDelete, "/api/admin/agent-skills/"+item.ID+"?revision="+strconv.FormatInt(item.Revision, 10), "")
		if res.Code != http.StatusOK {
			t.Fatalf("delete system = %d %s", res.Code, res.Body.String())
		}
	}
	res = authenticatedProfileRequest(app, admin, http.MethodGet, "/api/admin/agent-skills", "")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"items":[]`) {
		t.Fatalf("defaults resurrected = %d %s", res.Code, res.Body.String())
	}
}

func TestAgentSkillStorageFailuresReturnSanitizedErrors(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	admin := adminSessionToken(t, app)
	failure := errors.New("private-database.example secret")
	backend := &profileDocumentErrorBackend{loadErr: failure}
	app.agentSkills = service.NewAgentSkillService(backend)
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		res := authenticatedProfileRequest(app, admin, method, "/api/profile/agent-skills", `{"name":"x","content":"x"}`)
		if res.Code != http.StatusInternalServerError || strings.Contains(res.Body.String(), failure.Error()) {
			t.Fatalf("read failure %s = %d %s", method, res.Code, res.Body.String())
		}
	}
	backend.loadErr, backend.saveErr = nil, failure
	backend.loadValue = map[string]any{"items": []service.AgentSkill{{ID: "personal-existing", Name: "x", Content: "x", Scope: "personal", Revision: 1}}}
	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		path := "/api/profile/agent-skills"
		if method == http.MethodDelete {
			path += "/personal-existing?revision=1"
		}
		res := authenticatedProfileRequest(app, admin, method, path, `{"name":"x","content":"x"}`)
		if res.Code != http.StatusInternalServerError || strings.Contains(res.Body.String(), failure.Error()) {
			t.Fatalf("write failure %s = %d %s", method, res.Code, res.Body.String())
		}
	}
	app.agentSkills = nil
	if res := authenticatedProfileRequest(app, admin, http.MethodGet, "/api/profile/agent-skills", ""); res.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing service = %d %s", res.Code, res.Body.String())
	}
}
