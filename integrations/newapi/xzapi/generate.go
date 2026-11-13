package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/videocontract"
)

func main() {
	if len(os.Args) != 2 {
		panic("usage: go run ./integrations/newapi/xzapi/generate.go OUTPUT_DIRECTORY")
	}
	data, err := os.ReadFile("integrations/newapi/xzapi/contract.json")
	if err != nil {
		panic(err)
	}
	var document struct {
		Contracts []videocontract.ImportedVideoModelContract `json:"contracts"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		panic(err)
	}
	if len(document.Contracts) != 1 {
		panic("expected one shared XZAPI contract")
	}
	contract := document.Contracts[0].Contract
	result, err := videocontract.GenerateNewAPIVideoPlugin(contract, videocontract.NewAPIVideoPluginOptions{
		Key: "xzapi-video", Version: "1.1.0", BaseURL: "https://api.xzapi.vip",
		Models: contract.Models, AuthMode: "bearer", DownloadMode: "task_content",
	})
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(os.Args[1], "generated.js"), []byte(result.Source), 0644); err != nil {
		panic(err)
	}
	reports, err := protocol.DryRunVideoModelContracts([]protocol.VideoModelContract{contract})
	if err != nil {
		panic(err)
	}
	data, err = json.MarshalIndent(reports, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(os.Args[1], "contract-dry-run.json"), append(data, '\n'), 0644); err != nil {
		panic(err)
	}
}
