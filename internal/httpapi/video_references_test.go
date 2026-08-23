package httpapi

import "testing"

func TestVideoReferenceFileType(t *testing.T) {
	valid := append([]byte("....ftypisom"), make([]byte, 16)...)
	if ext, contentType, ok := videoReferenceFileType(valid, "source.mp4"); !ok || ext != ".mp4" || contentType != "video/mp4" {
		t.Fatalf("mp4 type = %q, %q, %v", ext, contentType, ok)
	}
	if _, _, ok := videoReferenceFileType(valid, "source.webm"); ok {
		t.Fatal("webm was accepted as a video reference")
	}
	if _, _, ok := videoReferenceFileType([]byte("not a movie"), "source.mov"); ok {
		t.Fatal("invalid MOV container was accepted")
	}
}
