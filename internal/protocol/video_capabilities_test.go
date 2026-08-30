package protocol

import "testing"

func TestCanonicalVideoModelPreservesConfiguredModelID(t *testing.T) {
	for _, model := range []string{
		"kling/text-to-video",
		"bytedance/seedance-1-5-pro",
		"vendor/model.with_symbols-v1",
	} {
		if got := CanonicalVideoModel("  " + model + "  "); got != model {
			t.Fatalf("CanonicalVideoModel() = %q, want %q", got, model)
		}
	}
}

func TestVideoCapabilityRequiresMatchingContract(t *testing.T) {
	capability := VideoCapability("unconfigured/video-model")
	if len(capability.Sizes) != 0 || len(capability.Seconds) != 0 || len(capability.Resolutions) != 0 || capability.DefaultSeconds != 0 {
		t.Fatalf("unconfigured model received fallback capability: %#v", capability)
	}
}

func TestVideoCapabilityUsesDeclaredContract(t *testing.T) {
	capability := VideoCapability("minimax-h3-768p")
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
