package util

import "testing"

func TestAcceptsGzip(t *testing.T) {
	for _, test := range []struct {
		header string
		want   bool
	}{
		{"gzip", true}, {"br,gzip", true}, {"*;q=0.5", true}, {"gzip;q=0,*;q=1", false}, {"br", false}, {"gzip;q=bad", false},
	} {
		if got := AcceptsGzip(test.header); got != test.want {
			t.Errorf("AcceptsGzip(%q)=%t want %t", test.header, got, test.want)
		}
	}
}
