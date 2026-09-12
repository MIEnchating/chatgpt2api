package service

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"
)

type MyAssetGroup struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	AssetKeys []string `json:"assetKeys"`
}

type MyAssetGroupMutation struct {
	ID     string   `json:"id"`
	Name   *string  `json:"name"`
	Add    []string `json:"add"`
	Remove []string `json:"remove"`
}

func decodeMyAssetGroups(value any) []MyAssetGroup {
	groups := make([]MyAssetGroup, 0)
	for _, item := range util.AsMapSlice(value) {
		groups = append(groups, MyAssetGroup{ID: util.Clean(item["id"]), Name: util.Clean(item["name"]), AssetKeys: cleanMyAssetStrings(item["assetKeys"], 10000)})
	}
	return groups
}

func (s *MyAssetService) ListGroups(ownerID string) ([]MyAssetGroup, error) {
	if strings.TrimSpace(ownerID) == "" {
		return nil, errors.New("owner_id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	document, err := s.loadDocumentLocked(ownerID)
	return document.groups, err
}

// Groups contain personal references only and never grant access to assets.
func (s *MyAssetService) MutateGroup(ownerID, operation string, input MyAssetGroupMutation) ([]MyAssetGroup, error) {
	ownerID = strings.TrimSpace(ownerID)
	input.ID = strings.TrimSpace(input.ID)
	if ownerID == "" || input.ID == "" {
		return nil, errors.New("owner_id and group id are required")
	}
	if operation != "create" && operation != "update" && operation != "delete" {
		return nil, errors.New("invalid group operation")
	}
	if len(input.Add) > 10000 || len(input.Remove) > 10000 {
		return nil, errors.New("分组最多包含 10000 个素材")
	}
	for _, key := range append(slices.Clone(input.Add), input.Remove...) {
		if len(key) > 2048 || strings.TrimSpace(key) == "" {
			return nil, errors.New("素材标识无效")
		}
	}
	if input.Name != nil {
		name := strings.TrimSpace(*input.Name)
		if name == "" || utf8.RuneCountInString(name) > 80 {
			return nil, errors.New("分组名称须为 1 至 80 个字符")
		}
		input.Name = &name
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < myAssetSaveAttempts; attempt++ {
		document, err := s.loadDocumentLocked(ownerID)
		if err != nil {
			return nil, err
		}
		index := slices.IndexFunc(document.groups, func(group MyAssetGroup) bool { return group.ID == input.ID })
		if operation == "create" {
			if index >= 0 {
				return nil, errors.New("分组已存在")
			}
			if input.Name == nil {
				return nil, errors.New("请输入分组名称")
			}
			for _, group := range document.groups {
				if group.Name == *input.Name {
					return nil, errors.New("已存在同名分组")
				}
			}
			if len(document.groups) >= 200 {
				return nil, errors.New("最多创建 200 个分组")
			}
			document.groups = append(document.groups, MyAssetGroup{ID: input.ID, AssetKeys: []string{}})
			index = len(document.groups) - 1
		} else if index < 0 {
			return nil, errors.New("分组不存在，请刷新后重试")
		}
		if operation == "delete" {
			document.groups = slices.Delete(document.groups, index, index+1)
		} else {
			if input.Name != nil {
				for i, group := range document.groups {
					if i != index && group.Name == *input.Name {
						return nil, errors.New("已存在同名分组")
					}
				}
				document.groups[index].Name = *input.Name
			}
			keys := append(document.groups[index].AssetKeys, input.Add...)
			keys = slices.DeleteFunc(keys, func(key string) bool { return slices.Contains(input.Remove, key) })
			keys = cleanMyAssetStrings(keys, 10001)
			if len(keys) > 10000 {
				return nil, errors.New("分组最多包含 10000 个素材")
			}
			document.groups[index].AssetKeys = keys
		}
		if err := s.saveDocumentLocked(ownerID, document); err != nil {
			if errors.Is(err, storage.ErrConcurrentRowUpdate) {
				continue
			}
			return nil, fmt.Errorf("save asset groups: %w", err)
		}
		return document.groups, nil
	}
	return nil, storage.ErrConcurrentRowUpdate
}
