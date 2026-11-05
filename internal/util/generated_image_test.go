package util

import "testing"

func TestGeneratedSVG(t *testing.T) {
	valid := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><defs><linearGradient id="a"><stop offset="0" stop-color="red"/></linearGradient></defs><path fill="url(#a)" d="M0 0h50v50z"/></svg>`
	info, err := InspectGeneratedImage([]byte(valid))
	if err != nil || info.Format != "svg" || info.Width != 100 || info.Height != 80 {
		t.Fatalf("%#v %v", info, err)
	}
	for _, unsafe := range []string{
		`<script>alert(1)</script>`, `<image href="https://example.com/a.png"/>`, `<foreignObject/>`, `<use href="https://example.com/a.svg#id"/>`, `<rect onclick="alert(1)"/>`, `<rect fill="url(https://example.com)"/>`, `<style>@import 'https://example.com';</style>`,
	} {
		if _, err := InspectGeneratedImage([]byte(`<svg width="100" height="80">` + unsafe + `</svg>`)); err == nil {
			t.Errorf("accepted %s", unsafe)
		}
	}
}
