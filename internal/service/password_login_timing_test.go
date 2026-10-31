package service

import (
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestDummyPasswordHashMatchesProductionCost(t *testing.T) {
	cost, err := bcrypt.Cost([]byte(dummyPasswordHash))
	if err != nil || cost != bcrypt.DefaultCost {
		t.Fatalf("dummy hash cost = (%d, %v), want %d", cost, err, bcrypt.DefaultCost)
	}
	if verifyAccountPassword("any-password", dummyPasswordHash) {
		t.Fatal("dummy hash must never authenticate")
	}
}
