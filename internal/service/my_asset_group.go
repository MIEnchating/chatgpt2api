package service

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"chatgpt2api/internal/storage"
	"chatgpt2api/internal/util"

	"github.com/google/uuid"
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
		return nil, errors.New("标签最多包含 10000 个素材")
	}
	for _, keys := range [][]string{input.Add, input.Remove} {
		for _, key := range keys {
			if len(key) > 2048 || strings.TrimSpace(key) == "" {
				return nil, errors.New("素材标识无效")
			}
		}
	}
	removedKeys := make(map[string]struct{}, len(input.Remove))
	for _, key := range input.Remove {
		removedKeys[myAssetLabelKey(ownerID, key)] = struct{}{}
	}
	if input.Name != nil {
		name := strings.TrimSpace(*input.Name)
		if name == "" || utf8.RuneCountInString(name) > 80 {
			return nil, errors.New("标签名称须为 1 至 80 个字符")
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
				return nil, errors.New("标签已存在")
			}
			if input.Name == nil {
				return nil, errors.New("请输入标签名称")
			}
			for _, group := range document.groups {
				if group.Name == *input.Name {
					return nil, errors.New("已存在同名标签")
				}
			}
			if len(document.groups) >= 200 {
				return nil, errors.New("最多创建 200 个标签")
			}
			document.groups = append(document.groups, MyAssetGroup{ID: input.ID, AssetKeys: []string{}})
			index = len(document.groups) - 1
		} else if index < 0 {
			return nil, errors.New("标签不存在，请刷新后重试")
		}
		if operation == "delete" {
			document.groups = slices.Delete(document.groups, index, index+1)
		} else {
			if input.Name != nil {
				for i, group := range document.groups {
					if i != index && group.Name == *input.Name {
						return nil, errors.New("已存在同名标签")
					}
				}
				document.groups[index].Name = *input.Name
			}
			keys := append([]string(nil), document.groups[index].AssetKeys...)
			for _, key := range input.Add {
				keys = append(keys, myAssetLabelKey(ownerID, key))
			}
			keys = slices.DeleteFunc(keys, func(key string) bool {
				_, removed := removedKeys[strings.TrimSpace(key)]
				return removed
			})
			keys = cleanMyAssetStrings(keys, 10001)
			if len(keys) > 10000 {
				return nil, errors.New("标签最多包含 10000 个素材")
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

func myAssetLabelKey(ownerID, key string) string {
	key = strings.TrimSpace(key)
	if strings.HasPrefix(key, ownerID+":") {
		return "self:" + strings.TrimPrefix(key, ownerID+":")
	}
	return key
}

func myAssetLabelNames(groups []MyAssetGroup, key string) []string {
	names := []string{}
	for _, group := range groups {
		if slices.Contains(group.AssetKeys, key) {
			names = append(names, group.Name)
		}
	}
	return names
}

func projectMyAssetLabels(document *myAssetDocument) {
	for index := range document.items {
		document.items[index].Tags = myAssetLabelNames(document.groups, "self:"+document.items[index].ID)
	}
}

// Migrate each old label into the existing membership relation before dropping
// its duplicated item field. Existing memberships and names are preserved.
func unifyMyAssetLabels(ownerID string, document *myAssetDocument) {
	for index := range document.groups {
		keys := make([]string, 0, len(document.groups[index].AssetKeys))
		for _, key := range document.groups[index].AssetKeys {
			keys = append(keys, myAssetLabelKey(ownerID, key))
		}
		document.groups[index].AssetKeys = cleanMyAssetStrings(keys, 10000)
	}
	for _, item := range document.items {
		key := "self:" + item.ID
		for _, name := range item.Tags {
			index := slices.IndexFunc(document.groups, func(group MyAssetGroup) bool { return group.Name == name })
			if index < 0 {
				document.groups = append(document.groups, MyAssetGroup{ID: uuid.NewString(), Name: name, AssetKeys: []string{}})
				index = len(document.groups) - 1
			}
			if !slices.Contains(document.groups[index].AssetKeys, key) {
				document.groups[index].AssetKeys = append(document.groups[index].AssetKeys, key)
			}
		}
	}
	document.labelsUnified = true
	projectMyAssetLabels(document)
}

func addMyAssetLabels(document *myAssetDocument, assetID string, names []string) error {
	key := "self:" + assetID
	for _, name := range names {
		index := slices.IndexFunc(document.groups, func(group MyAssetGroup) bool { return group.Name == name })
		if index < 0 {
			if name == "" || utf8.RuneCountInString(name) > 80 {
				return errors.New("标签名称须为 1 至 80 个字符")
			}
			if len(document.groups) >= 200 {
				return errors.New("最多创建 200 个标签")
			}
			document.groups = append(document.groups, MyAssetGroup{ID: uuid.NewString(), Name: name, AssetKeys: []string{}})
			index = len(document.groups) - 1
		}
		if !slices.Contains(document.groups[index].AssetKeys, key) {
			document.groups[index].AssetKeys = append(document.groups[index].AssetKeys, key)
		}
	}
	return nil
}
