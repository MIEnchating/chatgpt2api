package protocol

import "testing"

func TestArkAgentPlanEndpointIdentification(t *testing.T) {
	for _, endpoint := range []string{"https://ark.example/api/plan/v3", "https://ark.example/api/plan/v3/"} {
		if !IsArkAgentPlanURL(endpoint) {
			t.Fatalf("plan endpoint missed: %s", endpoint)
		}
	}
	for _, endpoint := range []string{"https://ark.example/api/v3", "https://ark.example/api/plan/v30", "https://ark.example/proxy/api/plan/v3", "https://ark.example/api/v3?path=/api/plan/v3", "/api/plan/v3", "file://ark.example/api/plan/v3"} {
		if IsArkAgentPlanURL(endpoint) {
			t.Fatalf("non-plan endpoint matched: %s", endpoint)
		}
	}
}
