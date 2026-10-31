package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

func (a *App) handleCreationTaskEvents(w http.ResponseWriter, r *http.Request, identity service.Identity) {
	subscription, err := a.tasks.SubscribeTasks(identity)
	if err != nil {
		if !a.writeCreationTaskStorageError(w, err) {
			util.WriteError(w, http.StatusServiceUnavailable, "任务事件服务暂时不可用")
		}
		return
	}
	defer subscription.Close()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "private, no-store, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	write := func(value any) error {
		data, err := json.Marshal(value)
		if err != nil {
			return err
		}
		_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if _, err = fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
			return err
		}
		return controller.Flush()
	}
	publish := func() bool {
		event, err := subscription.Read()
		if err != nil {
			_ = write(map[string]string{"type": "error", "message": "任务事件连接已结束，请重新连接"})
			return false
		}
		if event.Type != "snapshot" && len(event.Items) == 0 && len(event.DeletedIDs) == 0 {
			return true
		}
		return write(event) == nil
	}
	if !publish() {
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-subscription.Changed():
			if !publish() {
				return
			}
		case <-heartbeat.C:
			// Revalidate long-lived sessions without querying auth storage for every token.
			current, authErr := a.authenticateSession(r, requestAuthCookieToken(r))
			if authErr != nil {
				// Storage is unreadable: keep the stream open and retry on the next heartbeat instead of reporting an expired session.
				continue
			}
			if current == nil {
				_ = write(map[string]any{"type": "error", "status": http.StatusUnauthorized, "message": "登录会话已失效，请重新登录"})
				return
			}
			if current.ID != identity.ID || current.OwnerID != identity.OwnerID || current.Role != identity.Role || !a.identityCanAccessRequest(*current, r) {
				_ = write(map[string]any{"type": "error", "status": http.StatusForbidden, "message": "任务访问权限已更改，请刷新页面"})
				return
			}
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			if controller.Flush() != nil {
				return
			}
		}
	}
}
