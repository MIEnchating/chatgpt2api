package protocol

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var videoRequestPathSegmentPattern = regexp.MustCompile(`[A-Za-z][A-Za-z0-9_]*|\[[0-9]+\]`)

// Paths may be reused across mutually exclusive generation modes, but values
// emitted in the same request must never overwrite each other or their parents.
func validateVideoContractRequestPathConflicts(contract VideoModelContract) error {
	for _, mode := range contract.Generation.Modes {
		paths := []string{
			"model", "prompt", contract.Request.DurationField, contract.Request.AspectRatioField,
			contract.Request.ResolutionField, contract.Request.GenerateAudioField,
			contract.Request.WatermarkField, contract.Request.GenerationModeField,
		}
		if contract.Driver == VideoContractDriverVolcengine {
			paths = append(paths, "metadata.content")
		}
		switch mode.Kind {
		case "image":
			if mode.Materials.FirstFrame.Max > 0 {
				paths = append(paths, contract.Request.FirstFrameField)
			}
			if mode.Materials.LastFrame.Max > 0 {
				paths = append(paths, contract.Request.LastFrameField)
			}
		case "reference":
			for _, field := range []struct {
				maximum int
				path    string
			}{
				{mode.Materials.Image.Max, contract.Request.ReferenceImagesField},
				{mode.Materials.Video.Max, contract.Request.ReferenceVideosField},
				{mode.Materials.Audio.Max, contract.Request.ReferenceAudiosField},
			} {
				if field.maximum > 0 {
					paths = append(paths, field.path)
				}
			}
		}
		for index, left := range paths {
			if left == "" {
				continue
			}
			for _, right := range paths[index+1:] {
				if right != "" && videoRequestPathsConflict(left, right) {
					return fmt.Errorf("生成模式 %s 的请求字段 %q 与 %q 冲突", mode.Label, left, right)
				}
			}
		}
	}
	return nil
}

func videoRequestPathsConflict(left, right string) bool {
	a := videoRequestPathSegmentPattern.FindAllString(left, -1)
	b := videoRequestPathSegmentPattern.FindAllString(right, -1)
	for index := 0; index < min(len(a), len(b)); index++ {
		leftIndex := strings.HasPrefix(a[index], "[")
		rightIndex := strings.HasPrefix(b[index], "[")
		if leftIndex != rightIndex {
			return true
		}
		if leftIndex {
			x, _ := strconv.Atoi(strings.Trim(a[index], "[]"))
			y, _ := strconv.Atoi(strings.Trim(b[index], "[]"))
			if x != y {
				return false
			}
		} else if a[index] != b[index] {
			return false
		}
	}
	return true
}
