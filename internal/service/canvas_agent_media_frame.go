package service

import (
	"math"
	"strconv"
	"strings"
)

func canvasAgentFitEmptyMediaFrame(node *CanvasNode) {
	if node.URL != "" || node.FreeResize {
		return
	}
	var size string
	switch node.Type {
	case "image":
		size = node.GenerationSize
	case "video":
		size = node.GenerationVideoSize
	default:
		return
	}
	parts := strings.FieldsFunc(size, func(r rune) bool { return r == ':' || r == 'x' || r == 'X' || r == '×' })
	if len(parts) != 2 {
		return
	}
	width, errWidth := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	height, errHeight := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if errWidth != nil || errHeight != nil || math.IsNaN(width) || math.IsNaN(height) || math.IsInf(width, 0) || math.IsInf(height, 0) || width <= 0 || height <= 0 {
		return
	}
	ratio := width / height
	if ratio < 0.25 || ratio > 4 {
		return
	}
	edge := math.Max(node.Width, node.Height)
	if edge <= 0 {
		return
	}
	newWidth, newHeight := edge, edge
	if ratio >= 1 {
		newHeight /= ratio
	} else {
		newWidth *= ratio
	}
	node.X += (node.Width - newWidth) / 2
	node.Y += (node.Height - newHeight) / 2
	node.Width, node.Height = newWidth, newHeight
}
