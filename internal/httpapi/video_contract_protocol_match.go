package httpapi

import "chatgpt2api/internal/protocol"

// Match only generated contracts whose wire behavior is identical to the
// built-in mapper. Provider-specific transformations require document evidence
// during extraction; model names never determine the driver here.
func matchGeneratedVideoContractProtocol(contract protocol.VideoModelContract) protocol.VideoModelContract {
	if contract.Driver != protocol.VideoContractDriverCustom && contract.Driver != protocol.VideoContractDriverOpenAI {
		return contract
	}
	candidate := contract
	candidate.Driver = protocol.VideoContractDriverOpenAI
	candidate.Transport.CreatePath = ""
	candidate.Transport.QueryPath = ""
	createPath, queryPath, err := videoContractDriverPaths(candidate, nil)
	if err != nil || contract.Transport.CreatePath != createPath || contract.Transport.QueryPath != queryPath {
		return contract
	}
	return candidate
}
