package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"chatgpt2api/internal/service"
)

func TestCanvasSharePublicReadOnlyAndRevocation(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	auth := adminSessionToken(t, app)
	request := func(method, path, body string, authenticated bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if authenticated {
			setRequestAuthCookie(req, auth)
		}
		res := httptest.NewRecorder()
		app.Handler().ServeHTTP(res, req)
		return res
	}
	res := request("GET", "/api/canvas", "", true)
	var workspace service.CanvasWorkspaceResult
	if err := json.Unmarshal(res.Body.Bytes(), &workspace); err != nil {
		t.Fatal(err)
	}
	identity := app.authenticateSession(httptest.NewRequest("GET", "/", nil), auth)
	if identity == nil {
		t.Fatal("missing identity")
	}
	owner := identityScope(*identity)
	imageBytes := httpTestPNGBytes(t)
	imageURL, err := app.images.SaveImageBytes(context.Background(), imageBytes, "", owner, "Owner")
	if err != nil {
		t.Fatal(err)
	}
	foreignURL, err := app.images.SaveImageBytes(context.Background(), imageBytes, "", "another-owner", "Other")
	if err != nil {
		t.Fatal(err)
	}
	workspace.Document.Nodes = []service.CanvasNode{
		{ID: "image/one", Type: "image", URL: imageURL, Width: 100, Height: 100, ScaleX: 1, ScaleY: 1},
		{ID: "foreign", Type: "image", URL: foreignURL, Width: 100, Height: 100, ScaleX: 1, ScaleY: 1},
	}
	if _, err := app.canvas.SaveAtRevision(owner, workspace.Document); err != nil {
		t.Fatal(err)
	}
	endpoint := "/api/canvas/shares?project_id=" + url.QueryEscape(workspace.Document.ID)
	for _, method := range []string{"GET", "POST", "DELETE"} {
		if res := request(method, endpoint, "", false); res.Code != http.StatusUnauthorized {
			t.Fatalf("anonymous manage %s: %d", method, res.Code)
		}
	}
	res = request("POST", endpoint, "", true)
	if res.Code != 200 {
		t.Fatalf("share create: %d %s", res.Code, res.Body.String())
	}
	var share service.CanvasShare
	if err := json.Unmarshal(res.Body.Bytes(), &share); err != nil {
		t.Fatal(err)
	}
	public := "/api/canvas-shares/" + share.Token
	res = request("GET", public, "", false)
	if res.Code != 200 || !strings.Contains(res.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("public read: %d %s", res.Code, res.Body.String())
	}
	media := public + "/media?node_id=" + url.QueryEscape("image/one")
	if res := request("GET", media, "", false); res.Code != 200 || !bytes.Equal(res.Body.Bytes(), imageBytes) {
		t.Fatalf("shared image: %d", res.Code)
	}
	if res := request("GET", public+"/media?node_id=foreign", "", false); res.Code != 404 {
		t.Fatalf("other owner's image: %d", res.Code)
	}
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		if res := request(method, public, `{}`, false); res.Code != http.StatusMethodNotAllowed {
			t.Fatalf("public mutation %s: %d", method, res.Code)
		}
	}
	if res := request("PUT", "/api/canvas", `{}`, false); res.Code != 401 {
		t.Fatalf("share bypassed auth: %d", res.Code)
	}
	if res := request("GET", public+"/media?node_id=unknown", "", false); res.Code != 404 {
		t.Fatalf("unknown media: %d", res.Code)
	}
	if res := request("DELETE", endpoint, "", true); res.Code != 200 {
		t.Fatalf("revoke: %d %s", res.Code, res.Body.String())
	}
	for _, suffix := range []string{"", "/media?node_id=unknown", "/media?node_id=image%2Fone"} {
		if res := request("GET", public+suffix, "", false); res.Code != 404 {
			t.Fatalf("revoked access: %d", res.Code)
		}
	}
	if res := request("GET", "/api/canvas-shares/invalid", "", false); res.Code != 404 {
		t.Fatalf("invalid token: %d", res.Code)
	}
}

func TestCanvasShareStorageMediaRangeAndOwnerIsolation(t *testing.T) {
	app := newTestApp(t)
	defer app.Close()
	alice, _ := createPasswordUserSession(t, app, "share-alice", "Password123!", "Alice")
	bob, _ := createPasswordUserSession(t, app, "share-bob", "Password123!", "Bob")
	uploaded, err := app.storageFiles.Upload(context.Background(), alice.ID, false, "video.mp4", "video/mp4", []byte("0123456789"), nil)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := app.storageFiles.Upload(context.Background(), bob.ID, false, "private.mp4", "video/mp4", []byte("private"), nil)
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := app.canvas.Workspace(alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	workspace.Document.Nodes = []service.CanvasNode{{ID: "video", Type: "video", URL: "/api/files/" + uploaded.ID + "/content", Width: 320, Height: 180, ScaleX: 1, ScaleY: 1, GenerationVideoModel: "test-video", GenerationVideoSeconds: 5}}
	if _, err := app.canvas.SaveAtRevision(alice.ID, workspace.Document); err != nil {
		t.Fatal(err)
	}
	share, err := app.canvas.CanvasShare(alice.ID, workspace.Document.ID, "create")
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/canvas-shares/" + share.Token + "/media?node_id=video"
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Range", "bytes=2-5")
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusPartialContent || res.Body.String() != "2345" || res.Header().Get("Content-Range") != "bytes 2-5/10" {
		t.Fatalf("shared video range: %d %s %v", res.Code, res.Body.String(), res.Header())
	}
	req = httptest.NewRequest(http.MethodHead, path, nil)
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	if res.Code != 200 || res.Body.Len() != 0 || res.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("HEAD: %d %v", res.Code, res.Header())
	}
	// A forged reference must still pass the storage object's ownership check.
	res = httptest.NewRecorder()
	app.serveCanvasShareMedia(res, httptest.NewRequest("GET", path, nil), alice.ID, service.CanvasNode{URL: "/api/files/" + foreign.ID + "/content"})
	if res.Code != 404 {
		t.Fatalf("foreign storage object: %d", res.Code)
	}
	if _, err := app.canvas.CanvasShare(alice.ID, workspace.Document.ID, "revoke"); err != nil {
		t.Fatal(err)
	}
	res = httptest.NewRecorder()
	app.Handler().ServeHTTP(res, httptest.NewRequest("GET", path, nil))
	if res.Code != 404 {
		t.Fatalf("revoked storage media: %d", res.Code)
	}
}
