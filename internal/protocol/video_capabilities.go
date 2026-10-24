package protocol

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
