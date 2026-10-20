package videocontract

import (
	"reflect"

	"chatgpt2api/internal/protocol"
)

// ReferenceForContract identifies the published snapshot actually selected for a task.
// A concurrent publication must not attribute an older snapshot to the new revision.
func (s *VideoModelContractService) ReferenceForContract(contract protocol.VideoModelContract, model string) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	reference := map[string]any{"name": contract.Name, "driver": contract.Driver}
	for _, item := range items {
		current, matches := protocol.ResolveVideoModelContract(item.Contract, model)
		if matches && reflect.DeepEqual(current, contract) {
			reference["id"] = item.ID
			reference["revision"] = item.Revision
			return reference, nil
		}
		for _, version := range item.Versions {
			previous, matches := protocol.ResolveVideoModelContract(version.Contract, model)
			if matches && reflect.DeepEqual(previous, contract) {
				reference["id"] = item.ID
				reference["revision"] = version.Revision
				return reference, nil
			}
		}
	}
	return reference, nil
}
