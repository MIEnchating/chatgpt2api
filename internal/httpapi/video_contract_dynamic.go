package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
)

const (
	maxVideoContractDocumentScripts = 24
	maxVideoContractScriptBytes     = 1 << 20
	videoContractDynamicPageError   = "文档页面需要 JavaScript 加载，当前未读取到接口正文；请提供公开的文档 JSON、Markdown 或 OpenAPI 链接，或上传文档"
)

var (
	videoContractCatalogListPattern   = regexp.MustCompile(`["']/api-docs/list["']`)
	videoContractCatalogDetailPattern = regexp.MustCompile(`["']/api-docs/detail["']`)
)

// Detect a loading shell using its main content, excluding navigation and scripts.
func videoContractHTMLIsLoadingShell(data []byte) bool {
	document, err := html.Parse(bytes.NewReader(data))
	if err != nil {
		return false
	}
	root := document
	var main, body *html.Node
	hasScript := false
	var locate func(*html.Node)
	locate = func(node *html.Node) {
		if node.Type == html.ElementNode {
			switch node.Data {
			case "main":
				if main == nil {
					main = node
				}
			case "body":
				body = node
			case "script":
				hasScript = true
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			locate(child)
		}
	}
	locate(document)
	if main != nil {
		root = main
	} else if body != nil {
		root = body
	}
	var text strings.Builder
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.ElementNode {
			switch node.Data {
			case "head", "header", "footer", "nav", "script", "style", "noscript", "svg", "canvas":
				return
			}
		}
		if node.Type == html.TextNode {
			text.WriteString(node.Data)
			text.WriteByte(' ')
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(root)
	content := strings.ToLower(strings.Join(strings.Fields(text.String()), " "))
	content = strings.TrimRight(content, ".… ")
	switch content {
	case "":
		return hasScript
	case "加载中", "正在加载", "文档加载中", "正在加载文档", "loading", "loading documentation", "loading docs":
		return true
	}
	return false
}

// Recognize the public catalog protocol from the page's own scripts. Scripts are
// inspected as text only; they never execute and cannot choose arbitrary APIs.
func discoverVideoContractDynamicCatalog(ctx context.Context, initial fetchedVideoContractDocument, remainingBytes *int, client videoContractHTTPClient) (bool, error) {
	document, err := html.Parse(bytes.NewReader(initial.data))
	if err != nil {
		return false, err
	}
	var scripts []*url.URL
	seen := map[string]bool{}
	foundList, foundDetail := false, false
	inspect := func(data []byte) {
		foundList = foundList || videoContractCatalogListPattern.Match(data)
		foundDetail = foundDetail || videoContractCatalogDetailPattern.Match(data)
	}
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.ElementNode && node.Data == "script" {
			for _, attribute := range node.Attr {
				if attribute.Key != "src" {
					continue
				}
				ref, parseErr := url.Parse(attribute.Val)
				if parseErr != nil {
					continue
				}
				resolved := initial.url.ResolveReference(ref)
				if resolved.User != nil || !sameHTTPOrigin(initial.url, resolved) || path.Ext(resolved.Path) != ".js" {
					continue
				}
				resolved.Fragment, resolved.RawFragment = "", ""
				if !seen[resolved.String()] {
					seen[resolved.String()] = true
					scripts = append(scripts, resolved)
				}
			}
			for child := node.FirstChild; child != nil; child = child.NextSibling {
				if child.Type == html.TextNode {
					inspect([]byte(child.Data))
				}
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(document)
	for index, script := range scripts {
		if foundList && foundDetail {
			return true, nil
		}
		if index >= maxVideoContractDocumentScripts || *remainingBytes <= 0 {
			return false, errors.New("动态文档脚本超过读取数量或大小限制；请提供文档数据接口链接或上传文档")
		}
		page, fetchErr := fetchVideoContractURL(ctx, script.String(), min(*remainingBytes, maxVideoContractScriptBytes), client)
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		if fetchErr != nil {
			continue
		}
		*remainingBytes -= len(page.data)
		if sameHTTPOrigin(initial.url, page.url) {
			inspect(page.data)
		}
	}
	return foundList && foundDetail, nil
}

type videoContractCatalogEnvelope struct {
	Code int             `json:"code"`
	Data json.RawMessage `json:"data"`
}

func fetchVideoContractCatalogData(ctx context.Context, base *url.URL, endpoint string, query url.Values, remainingBytes *int, client videoContractHTTPClient) (json.RawMessage, error) {
	target := &url.URL{Scheme: base.Scheme, Host: base.Host, Path: endpoint, RawQuery: query.Encode()}
	page, err := fetchVideoContractURL(ctx, target.String(), min(*remainingBytes, maxVideoContractIndexBytes), client)
	if err != nil {
		return nil, err
	}
	*remainingBytes -= len(page.data)
	if !sameHTTPOrigin(base, page.url) {
		return nil, errors.New("公开文档接口重定向到其他站点")
	}
	var envelope videoContractCatalogEnvelope
	if err := json.Unmarshal(page.data, &envelope); err != nil || envelope.Code != 200 || len(envelope.Data) == 0 || string(envelope.Data) == "null" {
		return nil, errors.New("公开文档接口没有返回有效的成功数据，请检查文档访问权限和接口状态")
	}
	return envelope.Data, nil
}

func fetchVideoContractDynamicCatalog(ctx context.Context, initial fetchedVideoContractDocument, remainingBytes int, client videoContractHTTPClient) (string, videoContractImportSource, error) {
	data, err := fetchVideoContractCatalogData(ctx, initial.url, "/api/api-docs/list", url.Values{"model_type": {"video"}}, &remainingBytes, client)
	if err != nil {
		return "", videoContractImportSource{}, fmt.Errorf("读取视频文档目录失败：%w", err)
	}
	var catalog struct {
		Capabilities []struct {
			ModelType string `json:"model_type"`
			Families  []struct {
				Items []struct {
					Slug string `json:"slug"`
					Name string `json:"name"`
				} `json:"items"`
			} `json:"families"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(data, &catalog); err != nil || catalog.Capabilities == nil {
		return "", videoContractImportSource{}, errors.New("公开文档目录缺少有效的模型分类")
	}
	var slugs []string
	names := map[string]string{}
	for _, capability := range catalog.Capabilities {
		if capability.ModelType != "video" {
			continue
		}
		for _, family := range capability.Families {
			for _, item := range family.Items {
				if item.Slug == "" || strings.TrimSpace(item.Slug) != item.Slug || len(item.Slug) > 200 {
					return "", videoContractImportSource{}, errors.New("视频文档目录包含无效的文档标识")
				}
				if _, exists := names[item.Slug]; !exists {
					slugs = append(slugs, item.Slug)
					names[item.Slug] = strings.Join(strings.Fields(firstNonEmpty(item.Name, item.Slug)), " ")
				}
			}
		}
	}
	if len(slugs) == 0 {
		return "", videoContractImportSource{}, errors.New("公开文档目录中没有视频接口文档，请检查该站点的视频模型发布配置")
	}
	if len(slugs) > maxVideoContractDocumentPages {
		return "", videoContractImportSource{}, fmt.Errorf("公开目录包含 %d 份视频文档，超过单次 %d 份限制；请使用具体文档接口链接缩小范围", len(slugs), maxVideoContractDocumentPages)
	}
	var content strings.Builder
	for _, slug := range slugs {
		data, err := fetchVideoContractCatalogData(ctx, initial.url, "/api/api-docs/detail", url.Values{"slug": {slug}}, &remainingBytes, client)
		if err != nil {
			return "", videoContractImportSource{}, fmt.Errorf("读取视频文档 %q 失败，已停止生成：%w", names[slug], err)
		}
		var detail struct {
			Slug      string            `json:"slug"`
			ModelType string            `json:"model_type"`
			Endpoints []json.RawMessage `json:"endpoints"`
		}
		if err := json.Unmarshal(data, &detail); err != nil || detail.Slug != slug || detail.ModelType != "video" || len(detail.Endpoints) == 0 {
			return "", videoContractImportSource{}, fmt.Errorf("视频文档 %q 的标识、类型或接口正文无效，已停止生成", names[slug])
		}
		var formatted bytes.Buffer
		if err := json.Indent(&formatted, data, "", "  "); err != nil {
			return "", videoContractImportSource{}, err
		}
		fmt.Fprintf(&content, "## 文档页面：%s\n\n%s\n\n", names[slug], formatted.String())
		if utf8.RuneCountInString(content.String()) > maxVideoContractDocumentCharacters {
			return "", videoContractImportSource{}, errors.New("视频文档正文超过单次分析长度限制；请使用具体文档接口链接缩小范围")
		}
	}
	return strings.TrimSpace(content.String()), videoContractImportSource{
		Type: "url", Name: fmt.Sprintf("%s（公开视频文档 %d 份）", initial.url.Hostname(), len(slugs)),
	}, nil
}
