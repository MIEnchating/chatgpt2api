package service

import (
	"encoding/json"
	"errors"
	"strings"
)

const WorkflowAgentSystemPrompt = `你是一个用于创建图片创作工作流的产品设计助理。请根据用户需求输出严格 JSON，不要输出 Markdown。
目标：把用户的自然语言需求整理为一个可复用的图片生成工作流。
要求：
1. 工作流必须面向同类型批量创作，变量字段要少而明确。
2. 变量名使用 snake_case，label 使用中文。
3. prompt_template 必须使用 {{variable_name}} 引用变量。
4. 如果用户需要“多张、系列、组图、文章配图、海报组、写真组、方案集”，mode 使用 multi_image_series；否则使用 single_image。
5. config 只输出必要配置，api_mode 可为 responses、images 或 chat。
6. variables 支持 text、textarea、number、select、boolean。
7. select 类型的 options 必须是字符串数组。
8. 多图工作流必须输出 series_config，用于先生成多条图片提示词草稿。
9. 输出 JSON 结构：
{
  "name": "工作流名称",
  "category": "分类",
  "description": "一句话描述",
  "mode": "single_image",
  "variables": [
    {"key":"product_name","label":"产品名称","type":"text","required":true,"default_value":"","options":[]}
  ],
  "config": {
    "prompt_template": "生成提示词模板",
    "system_prompt": "系统提示词，可空",
    "model": "",
    "image_model": "",
    "api_mode": "responses",
    "size": "auto",
    "quality": "auto",
    "count": "1",
    "timeout": "600",
    "negative_prompt": ""
  },
  "series_config": {
    "target_count": "4",
    "prompt_model": "",
    "prompt_channel_id": "",
    "prompt_instruction": "多图拆分规则，可空",
    "review_required": true,
    "concurrency": "3"
  },
  "warnings": []
}`

type WorkflowAgentDraftRequest struct {
	Prompt     string   `json:"prompt"`
	Scope      string   `json:"scope"`
	Model      string   `json:"model"`
	ChannelID  string   `json:"channel_id"`
	References []string `json:"references"`
}

type WorkflowAgentDraftResponse struct {
	Draft    map[string]any `json:"draft"`
	Warnings []string       `json:"warnings"`
	Model    string         `json:"model"`
}

func WorkflowAgentMessages(prompt string, references []string) []map[string]any {
	prompt = strings.TrimSpace(prompt)
	messages := []map[string]any{{"role": "system", "content": WorkflowAgentSystemPrompt}}
	content := []map[string]any{{"type": "text", "text": prompt}}
	for _, dataURL := range references {
		dataURL = strings.TrimSpace(dataURL)
		if strings.HasPrefix(dataURL, "data:image/") {
			content = append(content, map[string]any{
				"type":      "image_url",
				"image_url": map[string]string{"url": dataURL},
			})
		}
	}
	if len(content) == 1 {
		return append(messages, map[string]any{"role": "user", "content": prompt})
	}
	return append(messages, map[string]any{"role": "user", "content": content})
}

func NormalizeWorkflowAgentDraft(content, scope string) (map[string]any, []string, error) {
	content = strings.TrimSpace(content)
	jsonStart := strings.Index(content, "{")
	if jsonStart < 0 {
		jsonStart = strings.Index(content, "[")
	}
	if jsonStart >= 0 {
		content = content[jsonStart:]
	}
	jsonEnd := strings.LastIndex(content, "}")
	if bracketEnd := strings.LastIndex(content, "]"); bracketEnd > jsonEnd {
		jsonEnd = bracketEnd
	}
	if jsonEnd >= 0 {
		content = content[:jsonEnd+1]
	}

	var draft map[string]any
	if err := json.Unmarshal([]byte(content), &draft); err != nil {
		return nil, nil, errors.New("工作流 Agent 返回内容格式异常，请重试")
	}
	if strings.TrimSpace(scope) != "public" {
		draft["scope"] = "private"
	}
	if variables, ok := draft["variables"].([]any); ok {
		for index, value := range variables {
			variable, ok := value.(map[string]any)
			if !ok {
				continue
			}
			if key, ok := variable["key"].(string); ok {
				variable["key"] = sanitizeWorkflowVariableKey(key)
			}
			variables[index] = variable
		}
		draft["variables"] = variables
	}
	return draft, []string{}, nil
}

func sanitizeWorkflowVariableKey(key string) string {
	var result strings.Builder
	for _, value := range key {
		if value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9' || value == '_' || value == '-' {
			result.WriteRune(value)
		} else {
			result.WriteByte('_')
		}
	}
	if result.Len() == 0 {
		return "var"
	}
	return result.String()
}
