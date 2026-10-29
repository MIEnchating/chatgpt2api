package service

type ImageWorkbenchSettings struct {
	ImageSize              string `json:"image_size"`
	ImageSizeMode          string `json:"image_size_mode"`
	ImageAspectRatio       string `json:"image_aspect_ratio"`
	ImageResolution        string `json:"image_resolution"`
	ImageCustomRatio       string `json:"image_custom_ratio"`
	ImageCustomWidth       string `json:"image_custom_width"`
	ImageCustomHeight      string `json:"image_custom_height"`
	ImageSnapToMultiple16  bool   `json:"image_snap_to_multiple_16"`
	ImageQuality           string `json:"image_quality"`
	ImageCount             int    `json:"image_count"`
	ImageOutputFormat      string `json:"image_output_format"`
	ImageOutputCompression string `json:"image_output_compression"`
}

type VideoWorkbenchSettings struct {
	VideoTaskCount     int            `json:"video_task_count"`
	VideoParameters    map[string]any `json:"video_parameters"`
	VideoSize          string         `json:"video_size"`
	VideoSeconds       string         `json:"video_seconds"`
	VideoResolution    string         `json:"video_resolution"`
	VideoGenerateAudio bool           `json:"video_generate_audio"`
	VideoWatermark     bool           `json:"video_watermark"`
}

func applyWorkbenchSettings(preferences *ImageGenerationPreferences, previous, next CreationWorkbenchPreferences) {
	previous.ComposerMode = next.ComposerMode
	if next.ComposerMode == "image" {
		previous.ImageModel = next.ImageModel
		previous.ImageSize = next.ImageSize
		previous.ImageSizeMode = next.ImageSizeMode
		previous.ImageAspectRatio = next.ImageAspectRatio
		previous.ImageResolution = next.ImageResolution
		previous.ImageCustomRatio = next.ImageCustomRatio
		previous.ImageCustomWidth = next.ImageCustomWidth
		previous.ImageCustomHeight = next.ImageCustomHeight
		previous.ImageSnapToMultiple16 = next.ImageSnapToMultiple16
		previous.ImageQuality = next.ImageQuality
		previous.ImageCount = next.ImageCount
		previous.ImageOutputFormat = next.ImageOutputFormat
		previous.ImageOutputCompression = next.ImageOutputCompression
		if preferences.ImageModelSettings == nil {
			preferences.ImageModelSettings = map[string]ImageWorkbenchSettings{}
		}
		if next.ImageModel != "" {
			preferences.ImageModelSettings[next.ImageModel] = ImageWorkbenchSettings{
				ImageSize:              next.ImageSize,
				ImageSizeMode:          next.ImageSizeMode,
				ImageAspectRatio:       next.ImageAspectRatio,
				ImageResolution:        next.ImageResolution,
				ImageCustomRatio:       next.ImageCustomRatio,
				ImageCustomWidth:       next.ImageCustomWidth,
				ImageCustomHeight:      next.ImageCustomHeight,
				ImageSnapToMultiple16:  next.ImageSnapToMultiple16,
				ImageQuality:           next.ImageQuality,
				ImageCount:             next.ImageCount,
				ImageOutputFormat:      next.ImageOutputFormat,
				ImageOutputCompression: next.ImageOutputCompression,
			}
		}
	}
	if next.ComposerMode == "video" {
		previous.VideoTaskCount = next.VideoTaskCount
		previous.VideoParameters = next.VideoParameters
		previous.VideoModel = next.VideoModel
		previous.VideoSize = next.VideoSize
		previous.VideoSeconds = next.VideoSeconds
		previous.VideoResolution = next.VideoResolution
		previous.VideoGenerateAudio = next.VideoGenerateAudio
		previous.VideoWatermark = next.VideoWatermark
		if preferences.VideoModelSettings == nil {
			preferences.VideoModelSettings = map[string]VideoWorkbenchSettings{}
		}
		if next.VideoModel != "" {
			preferences.VideoModelSettings[next.VideoModel] = VideoWorkbenchSettings{
				VideoTaskCount:     next.VideoTaskCount,
				VideoParameters:    next.VideoParameters,
				VideoSize:          next.VideoSize,
				VideoSeconds:       next.VideoSeconds,
				VideoResolution:    next.VideoResolution,
				VideoGenerateAudio: next.VideoGenerateAudio,
				VideoWatermark:     next.VideoWatermark,
			}
		}
	}
	preferences.Workbench = previous
}
