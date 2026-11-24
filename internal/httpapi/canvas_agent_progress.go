package httpapi

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
)

type canvasProgressOperation struct {
	Path   []any `json:"path"`
	Value  any   `json:"value"`
	Remove bool  `json:"remove,omitempty"`
	Append bool  `json:"append,omitempty"`
}

// Progress frames start from the previous frame on this connection.
func canvasProgressChanges(ops []canvasProgressOperation, path []any, before, after any) []canvasProgressOperation {
	switch value := after.(type) {
	case map[string]any:
		if prior, ok := before.(map[string]any); ok {
			for key := range prior {
				if _, exists := value[key]; !exists {
					ops = append(ops, canvasProgressOperation{Path: append(slices.Clone(path), key), Remove: true})
				}
			}
			for key, next := range value {
				child := append(slices.Clone(path), key)
				if old, exists := prior[key]; exists {
					ops = canvasProgressChanges(ops, child, old, next)
				} else {
					ops = append(ops, canvasProgressOperation{Path: child, Value: next})
				}
			}
			return ops
		}
	case []any:
		if prior, ok := before.([]any); ok {
			for index := range min(len(prior), len(value)) {
				ops = canvasProgressChanges(ops, append(slices.Clone(path), index), prior[index], value[index])
			}
			for index := len(prior) - 1; index >= len(value); index-- {
				ops = append(ops, canvasProgressOperation{Path: append(slices.Clone(path), index), Remove: true})
			}
			for index := len(prior); index < len(value); index++ {
				ops = append(ops, canvasProgressOperation{Path: append(slices.Clone(path), index), Value: value[index]})
			}
			return ops
		}
	case string:
		if prior, ok := before.(string); ok && len(prior) >= 128 && len(value) > len(prior) && strings.HasPrefix(value, prior) {
			return append(ops, canvasProgressOperation{Path: path, Value: value[len(prior):], Append: true})
		}
	}
	if !reflect.DeepEqual(before, after) {
		ops = append(ops, canvasProgressOperation{Path: path, Value: after})
	}
	return ops
}

type canvasProgressDelta struct {
	Type         string                    `json:"type"`
	BaseRevision int64                     `json:"base_revision"`
	Revision     int64                     `json:"revision"`
	Operations   []canvasProgressOperation `json:"operations"`
}

type canvasProgressSnapshot struct {
	Type     string          `json:"type"`
	Document json.RawMessage `json:"document"`
}
