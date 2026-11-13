package videocontract

import (
	"fmt"
	"strings"

	"chatgpt2api/internal/protocol"
)

// MaterialUploadAPIKey resolves a private credential scoped to its contract and
// exact upload origin. It is never part of protocol contracts or version history.
func (s *VideoModelContractService) MaterialUploadAPIKey(id, baseURL string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return "", err
	}
	index := managedVideoContractIndex(items, id)
	if index < 0 {
		return "", fmt.Errorf("视频契约不存在")
	}
	return items[index].UploadCredentials[baseURL], nil
}

// An empty key explicitly removes only this contract's key for this address.
func (s *VideoModelContractService) SetMaterialUploadAPIKey(id, baseURL, apiKey string) error {
	provider, err := protocol.NormalizeVideoContractProvider(&protocol.VideoContractProvider{BaseURL: baseURL})
	if err != nil || provider == nil || provider.BaseURL != baseURL || !strings.HasPrefix(baseURL, "https://") {
		return fmt.Errorf("上传密钥必须绑定规范化的 HTTPS 上传地址")
	}
	apiKey = strings.TrimSpace(apiKey)
	if len(apiKey) > 16384 || strings.ContainsAny(apiKey, "\r\n\x00") {
		return fmt.Errorf("上传密钥格式无效")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.mutateLocked(preserveActiveVideoModelContracts, "保存视频契约上传密钥失败", func(items []ManagedVideoModelContract) ([]ManagedVideoModelContract, bool, error) {
		index := managedVideoContractIndex(items, id)
		if index < 0 {
			return nil, false, fmt.Errorf("视频契约不存在")
		}
		if items[index].UploadCredentials == nil {
			items[index].UploadCredentials = map[string]string{}
		}
		if apiKey == "" {
			delete(items[index].UploadCredentials, baseURL)
		} else {
			items[index].UploadCredentials[baseURL] = apiKey
		}
		return items, true, nil
	})
	return err
}
