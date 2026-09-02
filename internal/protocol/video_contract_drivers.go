package protocol

const (
	VideoContractDriverOpenAI     = "openai-videos"
	VideoContractDriverXAI        = "xai-videos"
	VideoContractDriverGeminiVeo  = "gemini-veo"
	VideoContractDriverVertexVeo  = "vertex-veo"
	VideoContractDriverDashScope  = "dashscope-video"
	VideoContractDriverVolcengine = "volcengine-video"
	VideoContractDriverKling      = "kling-video"
	VideoContractDriverMiniMax    = "minimax-video"
	VideoContractDriverVidu       = "vidu-video"
	VideoContractDriverKIE        = "kie-video"
	VideoContractDriverAPIMart    = "apimart-video"
	VideoContractDriverCustom     = "custom-video"
)

var videoContractDrivers = []string{
	VideoContractDriverOpenAI,
	VideoContractDriverXAI,
	VideoContractDriverGeminiVeo,
	VideoContractDriverVertexVeo,
	VideoContractDriverDashScope,
	VideoContractDriverVolcengine,
	VideoContractDriverKling,
	VideoContractDriverMiniMax,
	VideoContractDriverVidu,
	VideoContractDriverKIE,
	VideoContractDriverAPIMart,
	VideoContractDriverCustom,
}

func SupportedVideoContractDrivers() []string {
	return append([]string(nil), videoContractDrivers...)
}

func IsSupportedVideoContractDriver(driver string) bool {
	for _, candidate := range videoContractDrivers {
		if driver == candidate {
			return true
		}
	}
	return false
}
