package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMediaRequestPathParsersKeepPrefixAndEscapingRules(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		parse   func(*http.Request) (string, error)
		want    string
		wantErr string
	}{
		{name: "image", path: "/images/folder/a%20b.png", parse: imageFileRequestPath, want: "folder/a b.png"},
		{name: "reference", path: "/image-references/owner/reference.png", parse: imageReferenceFileRequestPath, want: "owner/reference.png"},
		{name: "thumbnail", path: "/image-thumbnails/owner/thumb.webp", parse: imageThumbnailRequestPath, want: "owner/thumb.webp"},
		{name: "empty image path", path: "/images/", parse: imageFileRequestPath, wantErr: "invalid image path"},
		{name: "wrong image prefix", path: "/image-references/owner/reference.png", parse: imageFileRequestPath, wantErr: "invalid image path"},
		{name: "empty thumbnail path", path: "/image-thumbnails/", parse: imageThumbnailRequestPath, wantErr: "invalid thumbnail path"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			got, err := test.parse(request)
			if test.wantErr != "" {
				if err == nil || err.Error() != test.wantErr {
					t.Fatalf("parse(%q) error = %v, want %q", test.path, err, test.wantErr)
				}
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("parse(%q) = %q, %v; want %q", test.path, got, err, test.want)
			}
		})
	}
}
