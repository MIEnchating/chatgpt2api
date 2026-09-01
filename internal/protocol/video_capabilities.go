package protocol

type VideoCapabilityProfile struct {
	Sizes                []string `json:"sizes"`
	Seconds              []int    `json:"seconds"`
	Resolutions          []string `json:"resolutions"`
	DefaultSize          string   `json:"default_size"`
	DefaultSeconds       int      `json:"default_seconds"`
	DefaultResolution    string   `json:"default_resolution"`
	FirstFrameImageLimit int      `json:"first_frame_image_limit"`
	ReferenceMode        bool     `json:"reference_mode"`
	AudioControl         string   `json:"audio_control"`
	Watermark            bool     `json:"watermark"`
	References           struct {
		Image int `json:"image"`
		Video int `json:"video"`
		Audio int `json:"audio"`
	} `json:"references"`
}

func VideoCapabilitySupports(profile VideoCapabilityProfile, size string, seconds int, resolution string) bool {
	if size != "" && !stringSliceContainsFold(profile.Sizes, size) {
		return false
	}
	if !intSliceContains(profile.Seconds, seconds) {
		return false
	}
	if resolution != "" && !stringSliceContainsFold(profile.Resolutions, resolution) {
		return false
	}
	return true
}

func VideoContractSupports(contract VideoModelContract, size string, seconds int, resolution string) bool {
	return VideoCapabilitySupports(videoCapabilityFromContract(contract), size, seconds, resolution)
}
