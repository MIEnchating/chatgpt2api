package protocol

import (
	"fmt"
	"strings"
)

// Model profiles replace model-specific capability, request and material transport settings.
type VideoModelContractProfile struct {
	Model      string                       `json:"model"`
	Capability VideoModelContractCapability `json:"capability"`
	Generation VideoModelContractGeneration `json:"generation"`
	Rules      []VideoModelContractRule     `json:"rules"`
	Transport  *VideoModelContractTransport `json:"transport,omitempty"`
	Request    *VideoModelContractRequest   `json:"request,omitempty"`
}

func videoModelProfileFromContract(model string, contract VideoModelContract) VideoModelContractProfile {
	transport := contract.Transport
	request := contract.Request
	return VideoModelContractProfile{Model: model, Capability: contract.Capability, Generation: contract.Generation, Rules: contract.Rules, Transport: &transport, Request: &request}
}

func applyVideoModelProfile(contract VideoModelContract, profile VideoModelContractProfile) VideoModelContract {
	contract.ModelProfiles = nil
	contract.Capability = profile.Capability
	contract.Generation = profile.Generation
	contract.Rules = profile.Rules
	if profile.Transport != nil {
		contract.Transport = *profile.Transport
	}
	if profile.Request != nil {
		contract.Request = *profile.Request
	}
	return contract
}

func normalizeVideoModelProfiles(contract VideoModelContract) ([]VideoModelContractProfile, error) {
	if len(contract.ModelProfiles) == 0 {
		return nil, nil
	}
	if len(contract.ModelProfiles) > MaxVideoContractModels {
		return nil, fmt.Errorf("每个契约最多配置 %d 个模型能力", MaxVideoContractModels)
	}
	profiles := make([]VideoModelContractProfile, 0, len(contract.ModelProfiles))
	seen := make(map[string]bool)
	for _, profile := range contract.ModelProfiles {
		model := strings.TrimSpace(profile.Model)
		key := strings.ToLower(model)
		if strings.Contains(model, "*") || !stringSliceContainsFold(contract.Models, model) {
			return nil, fmt.Errorf("模型能力 %q 必须对应 models 中的精确模型 ID", model)
		}
		if seen[key] {
			return nil, fmt.Errorf("模型能力 %q 重复", model)
		}
		seen[key] = true
		value, err := NormalizeVideoModelContract(applyVideoModelProfile(contract, profile))
		if err != nil {
			return nil, fmt.Errorf("模型 %s 的能力配置无效: %w", model, err)
		}
		profiles = append(profiles, videoModelProfileFromContract(model, value))
	}
	return profiles, nil
}

// ResolveVideoModelContract returns an owned, effective snapshot for a task.
func ResolveVideoModelContract(contract VideoModelContract, model string) (VideoModelContract, bool) {
	if !VideoContractMatchesModel(contract, model) {
		return VideoModelContract{}, false
	}
	for _, profile := range contract.ModelProfiles {
		if strings.EqualFold(profile.Model, strings.TrimSpace(model)) {
			return cloneVideoContract(applyVideoModelProfile(contract, profile)), true
		}
	}
	contract.ModelProfiles = nil
	return cloneVideoContract(contract), true
}
