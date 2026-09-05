package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

const (
	maxVideoContractDocumentPages = 24
	maxVideoContractDocumentLinks = 200
	maxVideoContractIndexBytes    = 1 << 20
)

var videoContractMarkdownLinkPattern = regexp.MustCompile(`\[([^\]\r\n]+)\]\(([^)\s]+)\)`)
var videoContractOpenAPIReferencePattern = regexp.MustCompile(`(?i)(?:spec-url|specurl|url)\s*[:=]\s*["']([^"']*(?:openapi|swagger|api-docs)[^"']*)["']`)

type videoContractHTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

type fetchedVideoContractDocument struct {
	data        []byte
	name        string
	contentType string
	url         *url.URL
}

type videoContractDocumentLink struct {
	name    string
	context string
	url     *url.URL
	index   int
}

type videoContractDocumentSite struct {
	baseURL        *url.URL
	remainingBytes int
	links          []videoContractDocumentLink
}

func fetchVideoContractDocumentSet(ctx context.Context, value string, client videoContractHTTPClient) (string, videoContractImportSource, error) {
	initial, err := fetchVideoContractURL(ctx, value, maxVideoContractDocumentBytes, client)
	if err != nil {
		return "", videoContractImportSource{}, err
	}
	initialContent, err := extractVideoContractDocument(initial.data, initial.name, initial.contentType)
	if err != nil {
		return "", videoContractImportSource{}, err
	}
	remainingBytes := maxVideoContractDocumentBytes - len(initial.data)
	links := make([]videoContractDocumentLink, 0)

	if isVideoContractLLMSIndex(initial.url) {
		links = discoverVideoContractMarkdownLinks(string(initial.data), initial.url)
	} else {
		for _, indexURL := range videoContractLLMSIndexURLs(initial.url) {
			if remainingBytes <= 0 {
				break
			}
			limit := min(remainingBytes, maxVideoContractIndexBytes)
			index, fetchErr := fetchVideoContractURL(ctx, indexURL.String(), limit, client)
			if fetchErr != nil || !sameHTTPOrigin(initial.url, index.url) {
				continue
			}
			remainingBytes -= len(index.data)
			links = append(links, discoverVideoContractMarkdownLinks(string(index.data), index.url)...)
		}
		if len(uniqueVideoContractDocumentLinks(links, initial.url)) == 0 && isVideoContractHTML(initial.contentType, initial.name) {
			links = discoverVideoContractHTMLLinks(initial.data, initial.url)
		}
	}

	links = uniqueVideoContractDocumentLinks(links, initial.url)
	if len(links) == 0 {
		return initialContent, videoContractImportSource{Type: "url", Name: initial.name}, nil
	}
	warnings := make([]string, 0, 1)
	if len(links) > maxVideoContractDocumentLinks {
		warnings = append(warnings, fmt.Sprintf("文档站包含 %d 个候选页面，仅向分析模型提供前 %d 个", len(links), maxVideoContractDocumentLinks))
		links = links[:maxVideoContractDocumentLinks]
	}
	for index := range links {
		links[index].index = index + 1
	}
	return initialContent, videoContractImportSource{
		Type: "url", Name: initial.name, Warnings: warnings,
		Site: &videoContractDocumentSite{baseURL: initial.url, remainingBytes: remainingBytes, links: links},
	}, nil
}

func fetchSelectedVideoContractDocuments(ctx context.Context, initialContent string, source videoContractImportSource, selected []int, client videoContractHTTPClient) (string, videoContractImportSource, error) {
	if source.Site == nil || len(selected) == 0 {
		source.Site = nil
		return initialContent, source, nil
	}
	selectedSet := make(map[int]struct{}, len(selected))
	for _, index := range selected {
		if index < 1 || index > len(source.Site.links) {
			return "", videoContractImportSource{}, fmt.Errorf("文档规划返回了无效的候选编号 %d", index)
		}
		selectedSet[index] = struct{}{}
	}
	if len(selectedSet) > maxVideoContractDocumentPages {
		return "", videoContractImportSource{}, fmt.Errorf("文档规划选择的页面超过 %d 个", maxVideoContractDocumentPages)
	}
	remainingBytes := source.Site.remainingBytes
	sections := make([]string, 0, len(selectedSet))
	failed := 0
	for _, link := range source.Site.links {
		if _, exists := selectedSet[link.index]; !exists {
			continue
		}
		if remainingBytes <= 0 {
			failed++
			continue
		}
		page, fetchErr := fetchVideoContractURL(ctx, link.url.String(), remainingBytes, client)
		if fetchErr != nil || !sameHTTPOrigin(source.Site.baseURL, page.url) {
			failed++
			continue
		}
		remainingBytes -= len(page.data)
		content, extractErr := extractVideoContractDocument(page.data, page.name, page.contentType)
		if extractErr != nil || strings.TrimSpace(content) == "" {
			failed++
			continue
		}
		name := strings.Join(strings.Fields(firstNonEmpty(link.name, page.name)), " ")
		sections = append(sections, "## 文档页面："+name+"\n\n"+content)
	}
	if len(sections) == 0 {
		return "", videoContractImportSource{}, errors.New("分析模型选择的文档页面均读取失败")
	}
	if failed > 0 {
		source.Warnings = append(source.Warnings, fmt.Sprintf("有 %d 个分析模型选择的页面读取失败或超出总大小限制", failed))
	}
	source.Name = fmt.Sprintf("%s（%d 个相关页面）", source.Site.baseURL.Hostname(), len(sections))
	source.Site = nil
	return strings.Join(sections, "\n\n"), source, nil
}

func fetchVideoContractURL(ctx context.Context, value string, limit int, client videoContractHTTPClient) (fetchedVideoContractDocument, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fetchedVideoContractDocument{}, errors.New("文档链接无效")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return fetchedVideoContractDocument{}, errors.New("文档链接无效")
	}
	req.Header.Set("User-Agent", "chatgpt2api-contract-import/1.0")
	req.Header.Set("Accept", "text/html,text/plain,text/markdown,application/json,application/yaml,application/vnd.openxmlformats-officedocument.wordprocessingml.document;q=0.9,*/*;q=0.1")
	response, err := client.Do(req)
	if err != nil {
		return fetchedVideoContractDocument{}, fmt.Errorf("读取文档链接失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fetchedVideoContractDocument{}, fmt.Errorf("文档链接返回 HTTP %d", response.StatusCode)
	}
	if limit <= 0 || response.ContentLength > int64(limit) {
		return fetchedVideoContractDocument{}, errors.New("链接文档不能超过总大小限制")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, int64(limit)+1))
	if err != nil {
		return fetchedVideoContractDocument{}, errors.New("读取文档内容失败")
	}
	if len(data) > limit {
		return fetchedVideoContractDocument{}, errors.New("链接文档不能超过总大小限制")
	}
	finalURL := parsed
	if response.Request != nil && response.Request.URL != nil {
		finalURL = response.Request.URL
	}
	return fetchedVideoContractDocument{
		data:        data,
		name:        videoContractDocumentResponseName(response, finalURL),
		contentType: response.Header.Get("Content-Type"),
		url:         finalURL,
	}, nil
}

func isVideoContractHTML(rawContentType, name string) bool {
	contentType, _, _ := mime.ParseMediaType(rawContentType)
	extension := strings.ToLower(path.Ext(name))
	return strings.EqualFold(contentType, "text/html") || strings.EqualFold(contentType, "application/xhtml+xml") || extension == ".html" || extension == ".htm"
}

func isVideoContractLLMSIndex(value *url.URL) bool {
	return value != nil && strings.EqualFold(path.Base(value.Path), "llms.txt")
}

func videoContractLLMSIndexURLs(base *url.URL) []*url.URL {
	if base == nil {
		return nil
	}
	directoryIndex := base.ResolveReference(&url.URL{Path: "llms.txt"})
	rootIndex := &url.URL{Scheme: base.Scheme, Host: base.Host, Path: "/llms.txt"}
	if directoryIndex.String() == rootIndex.String() {
		return []*url.URL{rootIndex}
	}
	return []*url.URL{directoryIndex, rootIndex}
}

func discoverVideoContractMarkdownLinks(content string, base *url.URL) []videoContractDocumentLink {
	links := make([]videoContractDocumentLink, 0)
	section := ""
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "## ") {
			section = strings.TrimSpace(strings.TrimPrefix(trimmed, "## "))
		}
		for _, match := range videoContractMarkdownLinkPattern.FindAllStringSubmatch(line, -1) {
			resolved := resolveVideoContractDocumentLink(base, match[2])
			if resolved == nil {
				continue
			}
			links = append(links, videoContractDocumentLink{name: strings.TrimSpace(match[1]), context: section + " " + trimmed, url: resolved})
		}
	}
	return links
}

func discoverVideoContractHTMLLinks(data []byte, base *url.URL) []videoContractDocumentLink {
	document, err := html.Parse(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	links := make([]videoContractDocumentLink, 0)
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.ElementNode {
			href := ""
			labels := make([]string, 0, 3)
			for _, attribute := range node.Attr {
				switch strings.ToLower(attribute.Key) {
				case "href":
					if strings.EqualFold(node.Data, "a") {
						href = attribute.Val
					}
				case "spec-url", "data-spec-url":
					href = attribute.Val
				case "title", "aria-label":
					labels = append(labels, attribute.Val)
				}
			}
			if href != "" {
				labels = append(labels, videoContractHTMLNodeText(node))
			}
			if resolved := resolveVideoContractDocumentLink(base, href); resolved != nil && href != "" {
				label := strings.Join(strings.Fields(strings.Join(labels, " ")), " ")
				if label == "" && !strings.EqualFold(node.Data, "a") {
					label = "OpenAPI specification"
				}
				links = append(links, videoContractDocumentLink{name: label, context: label, url: resolved})
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(document)
	for _, match := range videoContractOpenAPIReferencePattern.FindAllSubmatch(data, -1) {
		if resolved := resolveVideoContractDocumentLink(base, string(match[1])); resolved != nil {
			links = append(links, videoContractDocumentLink{name: "OpenAPI specification", context: "OpenAPI specification", url: resolved})
		}
	}
	return links
}

func videoContractHTMLNodeText(node *html.Node) string {
	var text strings.Builder
	var walk func(*html.Node)
	walk = func(current *html.Node) {
		if current.Type == html.ElementNode {
			switch strings.ToLower(current.Data) {
			case "script", "style", "noscript", "svg", "canvas":
				return
			}
		}
		if current.Type == html.TextNode {
			text.WriteString(current.Data)
			text.WriteByte(' ')
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	return strings.Join(strings.Fields(text.String()), " ")
}

func resolveVideoContractDocumentLink(base *url.URL, raw string) *url.URL {
	if base == nil {
		return nil
	}
	reference, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil
	}
	resolved := base.ResolveReference(reference)
	if resolved.Host == "" || resolved.User != nil || resolved.Scheme != "http" && resolved.Scheme != "https" || !sameHTTPOrigin(base, resolved) {
		return nil
	}
	resolved.Fragment = ""
	switch strings.ToLower(path.Ext(resolved.Path)) {
	case ".js", ".css", ".map", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".mp3", ".mp4", ".zip", ".gz", ".tar", ".pdf":
		return nil
	}
	return resolved
}

func uniqueVideoContractDocumentLinks(links []videoContractDocumentLink, base *url.URL) []videoContractDocumentLink {
	seen := make(map[string]struct{}, len(links))
	unique := make([]videoContractDocumentLink, 0, len(links))
	for _, link := range links {
		if link.url == nil || !sameHTTPOrigin(base, link.url) {
			continue
		}
		key := link.url.String()
		if key == base.String() {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, link)
	}
	return unique
}
