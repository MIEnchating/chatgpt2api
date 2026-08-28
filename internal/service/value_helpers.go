package service

import "strings"

func anyList(value any) []any {
	switch list := value.(type) {
	case []any:
		return list
	case []map[string]any:
		out := make([]any, len(list))
		for index, item := range list {
			out[index] = item
		}
		return out
	default:
		return []any{}
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
