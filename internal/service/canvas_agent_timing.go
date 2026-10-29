package service

import (
	"time"

	"chatgpt2api/internal/util"
)

// Accumulate only processing time; user input and offline time are excluded.
func setCanvasAgentProcessing(message map[string]any, processing bool, now time.Time) {
	if message == nil {
		return
	}
	elapsed := max(0, int64(util.ToInt(message["elapsedMs"], 0)))
	started := int64(util.ToInt(message["processingStartedAt"], 0))
	if started > 0 {
		elapsed += max(0, now.UnixMilli()-started)
	}
	if !processing && started == 0 {
		return
	}
	message["elapsedMs"] = elapsed
	if processing {
		message["processingStartedAt"] = now.UnixMilli()
	} else {
		delete(message, "processingStartedAt")
	}
}
