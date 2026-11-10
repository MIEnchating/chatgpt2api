package main

import (
	"encoding/json"
	"fmt"
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
	var contracts []protocol.VideoModelContract
	for index, item := range document.Contracts {
		contracts = append(contracts, item.Contract)
		result, err := videocontract.GenerateNewAPIVideoPlugin(item.Contract, videocontract.NewAPIVideoPluginOptions{
			Key: fmt.Sprintf("xzapi-group-%d", index), Version: "1.0.0", BaseURL: "https://api.xzapi.vip",
			Models: item.Contract.Models, AuthMode: "bearer", DownloadMode: "task_content",
		})
		if err != nil {
			panic(err)
		}
		if err := os.WriteFile(filepath.Join(os.Args[1], fmt.Sprintf("group-%d.js", index)), []byte(result.Source), 0644); err != nil {
			panic(err)
		}
	}
	reports, err := protocol.DryRunVideoModelContracts(contracts)
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
