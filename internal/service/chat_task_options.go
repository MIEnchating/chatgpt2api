package service

import (
	"encoding/json"
	"fmt"
	"math"
)

func ValidateChatTaskOptions(metadata map[string]any) error {
	if value, exists := metadata["api_mode"]; exists {
		if value != "chat" && value != "responses" {
			return fmt.Errorf("api_mode 必须是 chat 或 responses")
		}
	}
	if value, exists := metadata["reasoning_enabled"]; exists {
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("reasoning_enabled 必须是布尔值")
		}
	}
	if value, exists := metadata["max_output_tokens"]; exists {
		var count float64
		switch number := value.(type) {
		case json.Number:
			parsed, err := number.Float64()
			if err != nil {
				return fmt.Errorf("max_output_tokens 必须是整数")
			}
			count = parsed
		case float64:
			count = number
		case int:
			count = float64(number)
		default:
			return fmt.Errorf("max_output_tokens 必须是整数")
		}
		if math.IsNaN(count) || math.IsInf(count, 0) || count < 1 || count > 128000 || math.Trunc(count) != count {
			return fmt.Errorf("max_output_tokens 必须是 1 到 128000 的整数")
		}
	}
	return nil
}
