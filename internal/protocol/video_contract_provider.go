package protocol

import (
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode"
)

// VideoContractProvider stores public connection hints, never credentials.
// Runtime routing remains owned by the configured relay or New API channel.
type VideoContractProvider struct {
	BaseURL    string `json:"base_url"`
	AuthMode   string `json:"auth_mode"`
	AuthHeader string `json:"auth_header"`
}

var videoProviderHeaderPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]{0,63}$`)

func NormalizeVideoContractProvider(input *VideoContractProvider) (*VideoContractProvider, error) {
	if input == nil {
		return nil, nil
	}
	p := *input
	p.BaseURL = strings.TrimSpace(p.BaseURL)
	p.AuthMode = strings.ToLower(strings.TrimSpace(p.AuthMode))
	p.AuthHeader = strings.TrimSpace(p.AuthHeader)
	if p.BaseURL != "" {
		u, err := url.Parse(p.BaseURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || strings.ContainsAny(p.BaseURL, "?#\\") {
			return nil, fmt.Errorf("供应商默认地址必须为不含凭据、查询参数和片段的 HTTP(S) Base URL")
		}
		for _, r := range p.BaseURL {
			if unicode.IsSpace(r) || unicode.IsControl(r) {
				return nil, fmt.Errorf("供应商默认地址不能含空白或控制字符")
			}
		}
		for _, r := range u.Hostname() {
			if r > unicode.MaxASCII {
				return nil, fmt.Errorf("供应商默认域名须使用 ASCII 或 punycode")
			}
		}
		u.Host = strings.ToLower(u.Host)
		p.BaseURL = strings.TrimRight(u.String(), "/")
		if len(p.BaseURL) > 191 {
			return nil, fmt.Errorf("供应商默认地址不能超过 191 个字符")
		}
	}
	if !slices.Contains([]string{"", "bearer", "header", "none"}, p.AuthMode) {
		return nil, fmt.Errorf("供应商鉴权方式无效")
	}
	if p.AuthMode == "header" {
		if !videoProviderHeaderPattern.MatchString(p.AuthHeader) || slices.Contains([]string{"authorization", "cookie", "host", "referer", "origin", "content-type", "content-length", "accept-encoding", "connection", "proxy-connection", "keep-alive", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"}, strings.ToLower(p.AuthHeader)) {
			return nil, fmt.Errorf("供应商自定义鉴权请求头无效；Authorization 请使用 Bearer")
		}
	} else if p.AuthHeader != "" {
		return nil, fmt.Errorf("仅自定义请求头鉴权可设置 auth_header")
	}
	if p.BaseURL == "" && p.AuthMode == "" {
		return nil, nil
	}
	return &p, nil
}
