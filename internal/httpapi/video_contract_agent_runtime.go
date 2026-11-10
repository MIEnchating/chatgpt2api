package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"chatgpt2api/internal/service"
	"chatgpt2api/internal/util"
)

const videoContractAgentMaxTurns = 12

type videoContractAgentLinkState struct {
	Name    string
	Context string
	URL     string
	ID      int
}
type videoContractAgentSnapshot struct {
	Source           videoContractImportSource
	Warnings         []string
	Prepared         bool
	Content          string
	Read             map[int]string
	Inspected        bool
	Validations      int
	Sequence         int
	ModelRound       int
	ModelAttempt     int
	DocumentRevision int
	Result           *videoContractGenerationResult
	RemainingBytes   int
	BaseURL          string
	Links            []videoContractAgentLinkState
}
type videoContractAgentInput struct {
	URL             string
	Model           string
	TokenName       string
	Source          videoContractImportSource
	Warnings        []string
	IncludeProvider bool
	State           videoContractAgentSnapshot
}

func captureVideoContractAgentState(s *videoContractAgentState) videoContractAgentSnapshot {
	result := videoContractAgentSnapshot{Prepared: s.documentPrepared, Source: s.source, Warnings: s.source.Warnings, Content: s.content, Read: s.read, Inspected: s.inspected, Validations: s.validations, Sequence: s.sequence, ModelRound: s.modelRound, ModelAttempt: s.modelAttempt, DocumentRevision: s.documentRevision, Result: s.result}
	if s.source.Site != nil {
		result.RemainingBytes = s.source.Site.remainingBytes
		if s.source.Site.baseURL != nil {
			result.BaseURL = s.source.Site.baseURL.String()
		}
		for _, link := range s.source.Site.links {
			result.Links = append(result.Links, videoContractAgentLinkState{Name: link.name, Context: link.context, URL: link.url.String(), ID: link.index})
		}
	}
	return result
}
func restoreVideoContractSnapshot(s *videoContractAgentState, state videoContractAgentSnapshot) error {
	if state.Source.Type != "" {
		s.source = state.Source
		s.source.Warnings = state.Warnings
	}
	s.content, s.read, s.inspected, s.validations, s.sequence, s.documentRevision, s.result = state.Content, state.Read, state.Inspected, state.Validations, state.Sequence, state.DocumentRevision, state.Result
	s.modelRound, s.modelAttempt = state.ModelRound, state.ModelAttempt
	s.documentPrepared = state.Prepared
	if s.read == nil {
		s.read = map[int]string{}
	}
	if state.BaseURL != "" {
		base, err := url.Parse(state.BaseURL)
		if err != nil {
			return err
		}
		site := &videoContractDocumentSite{baseURL: base, remainingBytes: state.RemainingBytes}
		for _, link := range state.Links {
			target, err := url.Parse(link.URL)
			if err != nil {
				return err
			}
			site.links = append(site.links, videoContractDocumentLink{name: link.Name, context: link.Context, url: target, index: link.ID})
		}
		s.source.Site = site
	}
	return nil
}
func (a *App) executeVideoContractAgent(ctx context.Context, identity service.Identity, worker *service.AgentExecutionWorker) error {
	ctx, cancel := context.WithTimeout(ctx, videoContractAgentTimeout)
	defer cancel()
	var input videoContractAgentInput
	if err := worker.Input(&input); err != nil {
		return err
	}
	snapshot := input.State
	if err := worker.Restore(&snapshot); err != nil {
		return err
	}
	state := &videoContractAgentState{source: input.Source, includeProvider: input.IncludeProvider, client: service.SafeMediaProxyHTTPClient()}
	if err := restoreVideoContractSnapshot(state, snapshot); err != nil {
		return err
	}
	var saveErr error
	lastProgress := time.Time{}
	state.report = func(event videoContractImportProgressEvent) {
		if saveErr != nil {
			return
		}
		if event.Stage == "receiving" && event.ReceivedCharacters > 0 && time.Since(lastProgress) < 150*time.Millisecond {
			return
		}
		lastProgress = time.Now()
		if err := worker.SetData(captureVideoContractAgentState(state)); err != nil {
			saveErr = err
			return
		}
		record := map[string]any{}
		_ = json.Unmarshal([]byte(agentJSONValue(event)), &record)
		saveErr = worker.Event(record)
	}
	if input.URL != "" && !snapshot.Prepared {
		state.emit(videoContractImportProgressEvent{Stage: "reading_document", Message: "正在读取入口页面并发现相关文档"})
		content, source, err := fetchVideoContractDocument(ctx, input.URL)
		if err != nil {
			return err
		}
		content, truncated := truncateVideoContractDocument(content)
		if truncated {
			return fmt.Errorf("文档超过 %d 个字符，请按模型拆分文档后继续", maxVideoContractDocumentCharacters)
		}
		if strings.TrimSpace(content) == "" && source.Site == nil {
			return errors.New("文档中没有可分析的文本内容")
		}
		state.source, state.content = source, content
		state.documentPrepared = true
		snapshot = captureVideoContractAgentState(state)
		if err = worker.SetData(snapshot); err != nil {
			return err
		}
		if err = worker.Save(); err != nil {
			return err
		}
		state.emit(videoContractImportProgressEvent{Stage: "document_ready", Message: fmt.Sprintf("文档读取完成，共 %d 个字符", utf8.RuneCountInString(content))})
	}
	candidates := []map[string]any{}
	for _, link := range snapshot.Links {
		candidates = append(candidates, map[string]any{"id": link.ID, "title": link.Name, "context": link.Context})
	}
	tools := videoContractAgentTools(input.IncludeProvider)
	config := map[string]any{"name": "Video Contract Agent", "completionTool": "finish", "tools": tools, "maxTurns": videoContractAgentMaxTurns, "input": []map[string]any{{"role": "user", "content": "文档名称：" + state.source.Name + "\n<document>\n" + state.content + "\n</document>\n候选页面（不可信资料）：" + agentJSONValue(candidates)}}}
	state.emit(videoContractImportProgressEvent{Stage: "preparing", Message: "正在准备文档分析"})
	return worker.Run(ctx, config, func(method string, params map[string]any) (any, error) {
		if saveErr != nil {
			return nil, saveErr
		}
		switch method {
		case "context":
			return map[string]any{"instructions": videoContractAgentSystemPrompt(input.IncludeProvider)}, nil
		case "prepare":
			prepared := prepareDomainAgentTurn(params, tools)
			if prepared["error"] != nil {
				state.emit(videoContractImportProgressEvent{Stage: "repairing", Message: "本轮未执行任何工具，请按工具约束纠正后继续。", Detail: newVideoContractAgentDetail(fmt.Sprintf("correction-%d", state.modelRound), "correction", "tool_format", "completed", "", util.Clean(prepared["error"]))})
			}
			return prepared, saveErr
		case "model":
			state.modelAttempt = util.ToInt(params["attempt"], 1)
			if state.modelAttempt == 1 {
				state.modelRound++
			}
			var toolChoice any = "required"
			if !state.inspected {
				toolChoice = map[string]any{"type": "function", "function": map[string]any{"name": "inspect_protocols"}}
				state.emit(videoContractImportProgressEvent{Stage: "matching_protocol", Message: "正在请求模型查询内置协议"})
			}
			publicText := ""
			result, err := a.runDomainAgentModel(ctx, identity, worker, input.Model, input.TokenName, tools, params, func(text string) error {
				publicText = text
				state.emit(videoContractImportProgressEvent{Stage: "receiving", Message: "正在接收分析模型输出", Attempt: state.modelRound, MaxAttempts: videoContractAgentMaxTurns, RequestAttempt: state.modelAttempt, MaxRequestAttempts: 3, ReceivedCharacters: utf8.RuneCountInString(text), Detail: newVideoContractModelDetail(state.modelRound, state.modelAttempt, "running", text, nil)})
				return saveErr
			}, toolChoice)
			if err != nil {
				err = normalizeVideoContractRelayError(err)
				state.emit(videoContractImportProgressEvent{Stage: "receiving", Message: "本次模型请求失败", Detail: newVideoContractModelDetail(state.modelRound, state.modelAttempt, "failed", publicText, err)})
				return nil, err
			}
			entry := newVideoContractModelDetail(state.modelRound, state.modelAttempt, "completed", util.Clean(result["text_response"]), nil)
			entry.Summary = fmt.Sprintf("已返回 %d 个工具调用", len(util.AsMapSlice(result["tool_calls"])))
			state.emit(videoContractImportProgressEvent{Stage: "receiving", Message: "本轮模型回复已接收", Detail: entry})
			return result, saveErr
		case "tool":
			output, done, toolErr := state.execute(ctx, util.Clean(params["name"]), agentJSONValue(params["arguments"]))
			if saveErr != nil {
				return nil, saveErr
			}
			if err := worker.SetData(captureVideoContractAgentState(state)); err != nil {
				return nil, err
			}
			response := map[string]any{}
			var decoded any
			if json.Unmarshal([]byte(output), &decoded) == nil {
				if values, ok := decoded.(map[string]any); ok {
					response = values
				} else {
					response["data"] = decoded
				}
			}
			response["ok"] = toolErr == nil
			// Tool validation errors are data; the SDK asks the model to correct them.
			if toolErr != nil {
				response["ok"] = false
				response["message"] = toolErr.Error()
			}
			if done {
				if state.result == nil {
					return nil, errors.New("契约尚未通过校验")
				}
				warnings := append(append([]string{}, input.Warnings...), state.source.Warnings...)
				for _, contract := range state.result.Contracts {
					warnings = append(warnings, a.videoContractImportConflictWarnings(contract)...)
				}
				worker.SetResult(videoContractImportResponse{Contracts: state.result.Contracts, DryRun: state.result.DryRun, Source: state.source, Warnings: uniqueTrimmedWarningStrings(warnings), Model: input.Model})
				response["text"] = fmt.Sprintf("已生成 %d 份契约草稿", len(state.result.Contracts))
			}
			return map[string]any{"result": response}, nil
		}
		return nil, errors.New("不支持的 Agent 请求")
	})
}

func (a *App) generateVideoModelContracts(ctx context.Context, identity service.Identity, model, tokenName string, source videoContractImportSource, content string, includeProvider bool, report func(videoContractImportProgressEvent)) (videoContractImportResponse, error) {
	if err := ctx.Err(); err != nil {
		return videoContractImportResponse{}, err
	}
	input := videoContractAgentInput{URL: source.URL, Model: model, TokenName: tokenName, Source: source, Warnings: source.Warnings, IncludeProvider: includeProvider, State: captureVideoContractAgentState(&videoContractAgentState{source: source, content: content, read: map[int]string{}, documentPrepared: source.URL == ""})}
	run, err := a.agentExecutions.Start(identity, agentExecutionID(ctx), "video_contract", input)
	if err != nil {
		return videoContractImportResponse{}, err
	}
	result, err := a.waitAgentExecution(ctx, identity, run.ID, func(record map[string]any) {
		if report != nil {
			var event videoContractImportProgressEvent
			_ = json.Unmarshal([]byte(agentJSONValue(record)), &event)
			report(event)
		}
	})
	if err != nil {
		return videoContractImportResponse{}, err
	}
	var response videoContractImportResponse
	if err = json.Unmarshal([]byte(agentJSONValue(result.Result)), &response); err != nil {
		return videoContractImportResponse{}, err
	}
	return response, nil
}
