package util

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestDecodeJSONAcceptsSingleValueAndPreservesNumbers(t *testing.T) {
	var payload map[string]any
	if err := DecodeJSON(strings.NewReader("  {\"count\": 9007199254740993} \n\t"), &payload); err != nil {
		t.Fatalf("DecodeJSON() error = %v", err)
	}
	if got, ok := payload["count"].(json.Number); !ok || got.String() != "9007199254740993" {
		t.Fatalf("decoded count = %#v, want json.Number", payload["count"])
	}
}

func TestDecodeJSONRejectsTrailingData(t *testing.T) {
	for _, body := range []string{
		"{\"value\":1} {\"value\":2}",
		"{\"value\":1} null",
		"{\"value\":1} trailing",
	} {
		var payload map[string]any
		if err := DecodeJSON(strings.NewReader(body), &payload); err == nil {
			t.Fatalf("DecodeJSON(%q) error = nil", body)
		}
	}
}

func TestStrictIntRequiresAnExactPlatformInteger(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
		want  int
		ok    bool
	}{
		{name: "int", value: 7, want: 7, ok: true},
		{name: "integral float", value: float64(7), want: 7, ok: true},
		{name: "trimmed string", value: " 7 ", want: 7, ok: true},
		{name: "json number", value: json.Number("7"), want: 7, ok: true},
		{name: "fractional float", value: 1.5},
		{name: "fractional json number", value: json.Number("1.0")},
		{name: "scientific json number", value: json.Number("1e1")},
		{name: "boolean", value: true},
		{name: "empty string", value: ""},
		{name: "positive infinity", value: math.Inf(1)},
		{name: "overflow", value: json.Number("18446744073709551615")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := StrictInt(tc.value)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("StrictInt(%#v) = (%d, %v), want (%d, %v)", tc.value, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestToIntFallsBackForOutOfRangeAndNonFiniteNumbers(t *testing.T) {
	const fallback = 17
	for _, value := range []any{
		math.MaxFloat64,
		-math.MaxFloat64,
		math.NaN(),
		math.Inf(1),
		json.Number("18446744073709551615"),
	} {
		if got := ToInt(value, fallback); got != fallback {
			t.Errorf("ToInt(%T(%v)) = %d, want fallback %d", value, value, got, fallback)
		}
	}
	if got := ToInt(3.9, fallback); got != 3 {
		t.Fatalf("ToInt(3.9) = %d, want existing truncation behavior", got)
	}
}

func TestToBoolAcceptsOnlyRecognizedScalarValues(t *testing.T) {
	tests := []struct {
		name  string
		value any
		want  bool
	}{
		{name: "bool true", value: true, want: true},
		{name: "bool false", value: false},
		{name: "integer one", value: 1, want: true},
		{name: "integer zero", value: int64(0)},
		{name: "negative integer", value: int32(-1), want: true},
		{name: "unsigned zero", value: uint64(0)},
		{name: "unsigned nonzero", value: uint8(2), want: true},
		{name: "float zero", value: float64(0)},
		{name: "float nonzero", value: float32(0.5), want: true},
		{name: "float nan", value: math.NaN()},
		{name: "float infinity", value: math.Inf(1)},
		{name: "json integer zero", value: json.Number("0")},
		{name: "json decimal", value: json.Number("0.5"), want: true},
		{name: "invalid json number", value: json.Number("invalid")},
		{name: "true string", value: " yes ", want: true},
		{name: "false string", value: "false"},
		{name: "true bytes", value: []byte("ON"), want: true},
		{name: "map", value: map[string]any{"enabled": true}},
		{name: "slice", value: []any{true}},
		{name: "nil", value: nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ToBool(test.value); got != test.want {
				t.Fatalf("ToBool(%T(%v)) = %v, want %v", test.value, test.value, got, test.want)
			}
		})
	}
}
