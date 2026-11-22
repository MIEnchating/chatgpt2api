package protocol

import (
	"slices"
	"strings"
)

// Draft/final is a Seedance 2.5 request workflow, independent of reference generation modes.
func SupportsVideoDraft(model string, contract VideoModelContract) bool {
	name := strings.NewReplacer("_", "-", ".", "-").Replace(strings.ToLower(model))
	seedance := strings.Contains(name, "seedance-2-5") || strings.Contains(name, "seedance2-5") || strings.Contains(name, "sd2-5")
	return seedance && slices.Contains(contract.Capability.Resolutions, "480p") && slices.Contains(contract.Capability.Resolutions, "1080p") && (contract.Driver == VideoContractDriverArk || contract.Driver == VideoContractDriverAPIMart)
}
