package service

import (
	"strings"
	"testing"
)

func TestPasswordValidationMatchesBcryptByteLimit(t *testing.T) {
	for _, test := range []struct {
		password string
		valid    bool
	}{
		{strings.Repeat("a", 7), false},
		{strings.Repeat("a", 8), true},
		{strings.Repeat("a", 72), true},
		{strings.Repeat("a", 73), false},
		{strings.Repeat("密", 24), true},
		{strings.Repeat("密", 25), false},
	} {
		if err := validateAccountPassword(test.password); (err == nil) != test.valid {
			t.Fatalf("password of %d bytes: %v, want valid=%t", len(test.password), err, test.valid)
		}
	}
}
