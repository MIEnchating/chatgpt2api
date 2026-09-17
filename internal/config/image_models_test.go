package config

import (
	"os"
	"reflect"
	"testing"

	"chatgpt2api/internal/model"
)

func TestImageModelDefinitionsPersistAndRejectInvalidUpdates(t *testing.T) {
	t.Setenv("ROOT_DIR", t.TempDir())
	unsetEnv(t, "IMAGE_MODEL_DEFINITIONS")
	store, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	definition := model.ImageModelDefinition{
		Protocol: "google-gemini-image", AspectRatios: []string{"1:1", "4:1"}, Resolutions: []string{"512", "4k"},
		QualityValues: []string{}, MaxReferenceImages: 14, MaxOutputCount: 5,
	}
	want := map[string]model.ImageModelDefinition{"my-image-alias": definition}
	if _, err := store.Update(map[string]any{"image_model_definitions": want}); err != nil {
		t.Fatal(err)
	}
	if err := os.Unsetenv("IMAGE_MODEL_DEFINITIONS"); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.ImageModelDefinitions(); !reflect.DeepEqual(got, want) {
		t.Fatalf("reloaded definitions = %#v, want %#v", got, want)
	}
	for _, mutate := range []func(*model.ImageModelDefinition){
		func(d *model.ImageModelDefinition) { d.Protocol = "unknown" },
		func(d *model.ImageModelDefinition) { d.MaxOutputCount = 0 },
		func(d *model.ImageModelDefinition) { d.MaxReferenceImages = -1 },
		func(d *model.ImageModelDefinition) { d.Mask = true },
		func(d *model.ImageModelDefinition) { d.Streaming = true },
		func(d *model.ImageModelDefinition) { d.AspectRatios = []string{"NaN:1"} },
		func(d *model.ImageModelDefinition) { d.Resolutions = []string{"8k"} },
	} {
		invalid := definition
		mutate(&invalid)
		if _, err := reloaded.Update(map[string]any{"image_model_definitions": map[string]model.ImageModelDefinition{"my-image-alias": invalid}}); err == nil {
			t.Fatalf("accepted invalid definition %#v", invalid)
		}
		if !reflect.DeepEqual(reloaded.ImageModelDefinitions(), want) {
			t.Fatal("invalid update mutated configuration")
		}
	}
	if _, err := reloaded.Update(map[string]any{"image_model_definitions": map[string]any{}}); err != nil {
		t.Fatal(err)
	}
	if len(reloaded.ImageModelDefinitions()) != 0 {
		t.Fatal("definitions were not removed")
	}
}

func TestImageModelDefinitionsRejectInvalidEnvironment(t *testing.T) {
	t.Setenv("ROOT_DIR", t.TempDir())
	t.Setenv("IMAGE_MODEL_DEFINITIONS", `{"alias":{"protocol":"invalid","max_output_count":1}}`)
	if _, err := NewStore(); err == nil {
		t.Fatal("invalid environment configuration was accepted")
	}
}
