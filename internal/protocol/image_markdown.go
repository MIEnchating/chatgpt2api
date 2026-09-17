package protocol

import (
	"net/url"
	"regexp"
)

var markdownImageURLRE = regexp.MustCompile(`!\[[^\]\r\n]*\]\(\s*(?:<(https?://[^<>\r\n]+)>|(https?://[^\s()<>]+(?:\([^\s()<>]*\)[^\s()<>]*)*))(?:\s+"[^"\r\n]*"|\s+'[^'\r\n]*')?\s*\)`)

// ExtractMarkdownImageURLs returns absolute HTTP image destinations, not prose links.
func ExtractMarkdownImageURLs(text string) []string {
	var urls []string
	seen := map[string]bool{}
	for _, match := range markdownImageURLRE.FindAllStringSubmatch(text, -1) {
		value := match[1]
		if value == "" {
			value = match[2]
		}
		parsed, err := url.Parse(value)
		if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || seen[value] {
			continue
		}
		seen[value] = true
		urls = append(urls, value)
	}
	return urls
}
