package protocol

import (
	"slices"
	"testing"
)

func TestExtractMarkdownImageURLs(t *testing.T) {
	for _, test := range []struct {
		name string
		text string
		want []string
	}{
		{"image", "Here is your image: ![image](https://cdn.example.test/images/cat.png)", []string{"https://cdn.example.test/images/cat.png"}},
		{"signed URL", "![cat](https://cdn.example.test/image?key=a%2Fb&signature=x%2By%3D)", []string{"https://cdn.example.test/image?key=a%2Fb&signature=x%2By%3D"}},
		{"multiple and duplicate", "![a](https://cdn.example.test/a)\n![b](http://cdn.example.test/b)\n![a](https://cdn.example.test/a)", []string{"https://cdn.example.test/a", "http://cdn.example.test/b"}},
		{"parentheses", "![image](https://cdn.example.test/cat(1).png)", []string{"https://cdn.example.test/cat(1).png"}},
		{"angle destination and title", `![image](<https://cdn.example.test/cat.png> "cat")`, []string{"https://cdn.example.test/cat.png"}},
		{"title", `![image](https://cdn.example.test/cat.png 'cat')`, []string{"https://cdn.example.test/cat.png"}},
		{"ordinary links", "See https://example.test/cat.png or [image](https://example.test/cat.png)", nil},
		{"inline image", "![image](data:image/png;base64,AQID)", nil},
		{"unsupported destinations", "![a](file:///tmp/cat.png) ![b](javascript:alert(1)) ![c](/cat.png) ![d](https:///cat.png)", nil},
		{"malformed", "![image](https://cdn.example.test/%zz) ![image](https://cdn.example.test/missing", nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := ExtractMarkdownImageURLs(test.text); !slices.Equal(got, test.want) {
				t.Fatalf("ExtractMarkdownImageURLs() = %#v, want %#v", got, test.want)
			}
		})
	}
}
