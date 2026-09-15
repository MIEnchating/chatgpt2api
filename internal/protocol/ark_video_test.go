package protocol

import "testing"

func TestArkVideoContentMapsReferenceRoles(t *testing.T) {
	content, err := ArkVideoContent("scene", ArkVideoReferences{Images: []string{"https://cdn.example/image.png"}, Videos: []string{"https://cdn.example/video.mp4"}, Audio: []string{"https://cdn.example/audio.mp3"}})
	if err != nil {
		t.Fatal(err)
	}
	for index, kind := range []string{"image", "video", "audio"} {
		part := content[index+1]
		if part["role"] != "reference_"+kind || part["type"] != kind+"_url" {
			t.Fatalf("content[%d] = %#v", index+1, part)
		}
	}
	frames, err := ArkVideoContent("scene", ArkVideoReferences{FirstFrame: "https://cdn.example/first.png", LastFrame: "https://cdn.example/last.png"})
	if err != nil || frames[1]["role"] != "first_frame" || frames[2]["role"] != "last_frame" {
		t.Fatalf("frames = %#v, %v", frames, err)
	}
}

func TestArkVideoContentRejectsInvalidReferenceCombinations(t *testing.T) {
	for _, refs := range []ArkVideoReferences{
		{LastFrame: "https://cdn.example/last.png"},
		{FirstFrame: "https://cdn.example/first.png", Images: []string{"https://cdn.example/ref.png"}},
		{FirstFrame: "/api/files/private"}, {Videos: []string{"https://user:secret@cdn.example/video.mp4"}},
	} {
		if _, err := ArkVideoContent("scene", refs); err == nil {
			t.Fatalf("accepted %#v", refs)
		}
	}
}
