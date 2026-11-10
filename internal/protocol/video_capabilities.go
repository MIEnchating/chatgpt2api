package protocol

import "strings"

// VideoContractCanonicalOption returns the declared spelling for a case-insensitive option.
// Unknown values are returned unchanged so the normal contract validation can reject them.
func VideoContractCanonicalOption(options []string, value, fallback string) string {
	requested := strings.TrimSpace(value)
	if requested == "" {
		requested = strings.TrimSpace(fallback)
	}
	for _, option := range options {
		if strings.EqualFold(option, requested) {
			return option
		}
	}
	return requested
}

func VideoContractSupports(contract VideoModelContract, size string, seconds int, resolution string) bool {
	capability := contract.Capability
	if size != "" && !stringSliceContainsFold(capability.Sizes, size) {
		return false
	}
	if !VideoDurationSupported(capability, seconds) {
		return false
	}
	if resolution != "" && !stringSliceContainsFold(capability.Resolutions, resolution) {
		return false
	}
	return true
}
