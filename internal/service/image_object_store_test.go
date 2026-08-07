package service

import "testing"

func TestNormalizeS3Endpoint(t *testing.T) {
	tests := []struct {
		name     string
		value    string
		endpoint string
		secure   bool
		wantErr  bool
	}{
		{name: "https", value: "https://account.r2.cloudflarestorage.com", endpoint: "account.r2.cloudflarestorage.com", secure: true},
		{name: "implicit https", value: "s3.example.test", endpoint: "s3.example.test", secure: true},
		{name: "local minio", value: "http://minio:9000", endpoint: "minio:9000", secure: false},
		{name: "path rejected", value: "https://s3.example.test/api", wantErr: true},
		{name: "query rejected", value: "https://s3.example.test?bucket=test", wantErr: true},
		{name: "user info rejected", value: "https://key:secret@s3.example.test", wantErr: true},
		{name: "scheme rejected", value: "ftp://s3.example.test", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			endpoint, secure, err := normalizeS3Endpoint(test.value)
			if (err != nil) != test.wantErr {
				t.Fatalf("normalizeS3Endpoint() error = %v", err)
			}
			if endpoint != test.endpoint || secure != test.secure {
				t.Fatalf("normalizeS3Endpoint() = %q, %v", endpoint, secure)
			}
		})
	}
}

func TestNormalizeObjectPrefix(t *testing.T) {
	if prefix, err := normalizeObjectPrefix("/cloud-cotton/images/"); err != nil || prefix != "cloud-cotton/images" {
		t.Fatalf("normalizeObjectPrefix() = %q, %v", prefix, err)
	}
	for _, value := range []string{"../images", "images/../../secret", "C:/images"} {
		if _, err := normalizeObjectPrefix(value); err == nil {
			t.Fatalf("normalizeObjectPrefix(%q) accepted invalid prefix", value)
		}
	}
}
