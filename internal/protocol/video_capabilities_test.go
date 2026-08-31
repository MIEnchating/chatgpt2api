package protocol

import "testing"

func TestVideoContractLookupRequiresMatchingContract(t *testing.T) {
	if contract, ok := VideoContractForModel("unconfigured/video-model"); ok {
		t.Fatalf("unconfigured model received contract: %#v", contract)
	}
}

func TestVideoCapabilityUsesDeclaredContract(t *testing.T) {
	contract, ok := VideoContractForModel("  minimax-h3-768p  ")
	if !ok {
		t.Fatal("configured model did not match after trimming whitespace")
	}
	capability := videoCapabilityFromContract(contract)
	if capability.DefaultSeconds != 5 || capability.DefaultSize != "16:9" || capability.DefaultResolution != "768p" {
		t.Fatalf("declared capability defaults = %#v", capability)
	}
	if !VideoCapabilitySupports(capability, "9:16", 8, "768p") {
		t.Fatalf("declared capability rejected supported values: %#v", capability)
	}
	if VideoCapabilitySupports(capability, "2:1", 8, "768p") {
		t.Fatal("declared capability accepted an unsupported aspect ratio")
	}
}
