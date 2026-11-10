package service

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"chatgpt2api/internal/util"
)

var ErrAgentProgressPersistence = errors.New("Agent 进度保存失败")

// AgentModelStreamError marks a model response that failed while streaming.
// The SDK may safely retry it because no business tool result is acknowledged
// until the complete model turn has been received and validated.
type AgentModelStreamError struct {
	Err error
}

func (e AgentModelStreamError) Error() string { return e.Err.Error() }
func (e AgentModelStreamError) Unwrap() error { return e.Err }

// RunSDK is the shared SDK process host. Domain callbacks own authenticated
// business operations and persistence; only the SDK schedules model/tool turns.
func (*AgentExecutionService) RunSDK(ctx context.Context, config map[string]any, handle func(string, map[string]any) (any, error)) error {
	path := os.Getenv("AGENT_RUNTIME_PATH")
	if path == "" {
		path = "agent-runtime/worker.mjs"
	}
	binary := os.Getenv("AGENT_NODE_BINARY")
	if binary == "" {
		binary = "node"
	}
	command := exec.CommandContext(ctx, binary, path)
	// Only runtime configuration is inherited; application secrets stay in Go.
	command.Env = []string{"NODE_NO_WARNINGS=1", "ELECTRON_RUN_AS_NODE=1"}
	for _, key := range []string{"PATH", "HOME", "SystemRoot", "TEMP", "TMP", "USERPROFILE"} {
		if value, ok := os.LookupEnv(key); ok {
			command.Env = append(command.Env, key+"="+value)
		}
	}
	input, err := command.StdinPipe()
	if err != nil {
		return err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	command.Stderr = io.Discard
	if err = command.Start(); err != nil {
		return fmt.Errorf("启动 LangGraph 运行时失败，请安装 Node.js 22 和 agent-runtime 依赖: %w", err)
	}
	defer func() {
		input.Close()
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	encoder := json.NewEncoder(input)
	if err = encoder.Encode(config); err != nil {
		return err
	}
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	finished := false
	for scanner.Scan() {
		var request struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err = json.Unmarshal(scanner.Bytes(), &request); err != nil {
			return fmt.Errorf("无效 SDK worker 消息: %w", err)
		}
		if request.Method == "error" {
			return errors.New(util.Clean(request.Params["message"]))
		}
		result, callErr := handle(request.Method, request.Params)
		response := map[string]any{"id": request.ID, "result": result}
		if callErr != nil {
			response["error"] = callErr.Error()
			response["retryable"] = request.Method == "model" && AgentModelRetryable(callErr)
		}
		if err = encoder.Encode(response); err != nil {
			return err
		}
		if callErr == nil && (request.Method == "finish" || request.Method == "pause") {
			finished = true
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err = scanner.Err(); err != nil {
		return err
	}
	if err = command.Wait(); err != nil {
		return fmt.Errorf("LangGraph worker 执行失败: %w", err)
	}
	if !finished {
		return errors.New("LangGraph worker 未返回完成状态")
	}
	return nil
}

// AgentModelRetryable applies only to model requests, never business tool writes.
func AgentModelRetryable(err error) bool {
	if err == nil || errors.Is(err, ErrAgentProgressPersistence) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var httpErr interface{ HTTPStatusCode() int }
	if errors.As(err, &httpErr) {
		status := httpErr.HTTPStatusCode()
		return status == 408 || status == 429 || status >= 500
	}
	var streamError AgentModelStreamError
	if errors.As(err, &streamError) {
		return true
	}
	var networkError net.Error
	if errors.As(err, &networkError) && (networkError.Timeout() || networkError.Temporary()) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.EPIPE) {
		return true
	}
	message := err.Error()
	return strings.Contains(message, "stream error: stream ID ") && strings.Contains(message, "received from peer")
}
