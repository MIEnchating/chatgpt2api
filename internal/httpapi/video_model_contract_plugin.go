package httpapi

import (
	"net/http"

	"chatgpt2api/internal/protocol"
	"chatgpt2api/internal/util"
	"chatgpt2api/internal/videocontract"
)

func (a *App) handleVideoModelContractPlugin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Contract protocol.VideoModelContract            `json:"contract"`
		Options  videocontract.NewAPIVideoPluginOptions `json:"options"`
	}
	if err := decodeStrictJSON(http.MaxBytesReader(w, r.Body, 2<<20), &body); err != nil {
		util.WriteError(w, http.StatusBadRequest, "插件生成请求格式无效")
		return
	}
	result, err := videocontract.GenerateNewAPIVideoPlugin(body.Contract, body.Options)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, result)
}
