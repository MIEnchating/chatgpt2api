package service

import "chatgpt2api/internal/util"

func videoTaskContractReference(value any) map[string]any {
	raw := util.StringMap(value)
	name := util.Clean(raw["name"])
	if name == "" {
		return nil
	}
	reference := map[string]any{"name": name, "driver": util.Clean(raw["driver"])}
	if id := util.Clean(raw["id"]); id != "" {
		reference["id"] = id
	}
	if revision := util.ToInt(raw["revision"], 0); revision > 0 {
		reference["revision"] = revision
	}
	return reference
}
