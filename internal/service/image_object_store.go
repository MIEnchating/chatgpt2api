package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

const maxStoredImageBytes = 256 << 20

type ImageObjectStore interface {
	Backend() string
	Bucket() string
	Prefix() string
	Put(context.Context, string, []byte, string) error
	Get(context.Context, string) ([]byte, string, error)
	Delete(context.Context, string) error
}

type S3ImageObjectStoreConfig struct {
	Endpoint     string
	Bucket       string
	AccessKey    string
	SecretKey    string
	SessionToken string
	Region       string
	Prefix       string
	UsePathStyle bool
}

type s3ImageObjectStore struct {
	client *minio.Client
	bucket string
	prefix string
}

func NewS3ImageObjectStore(config S3ImageObjectStoreConfig) (ImageObjectStore, error) {
	endpoint, secure, err := normalizeS3Endpoint(config.Endpoint)
	if err != nil {
		return nil, err
	}
	bucket := strings.TrimSpace(config.Bucket)
	if bucket == "" {
		return nil, errors.New("S3 bucket is required")
	}
	accessKey := strings.TrimSpace(config.AccessKey)
	secretKey := strings.TrimSpace(config.SecretKey)
	if accessKey == "" || secretKey == "" {
		return nil, errors.New("S3 access key and secret key are required")
	}
	lookup := minio.BucketLookupAuto
	if config.UsePathStyle {
		lookup = minio.BucketLookupPath
	}
	client, err := minio.New(endpoint, &minio.Options{
		Creds:        credentials.NewStaticV4(accessKey, secretKey, strings.TrimSpace(config.SessionToken)),
		Secure:       secure,
		Region:       strings.TrimSpace(config.Region),
		BucketLookup: lookup,
	})
	if err != nil {
		return nil, fmt.Errorf("create S3 client: %w", err)
	}
	prefix, err := normalizeObjectPrefix(config.Prefix)
	if err != nil {
		return nil, err
	}
	return &s3ImageObjectStore{
		client: client,
		bucket: bucket,
		prefix: prefix,
	}, nil
}

func (s *s3ImageObjectStore) Backend() string { return "s3" }
func (s *s3ImageObjectStore) Bucket() string  { return s.bucket }
func (s *s3ImageObjectStore) Prefix() string  { return s.prefix }

func (s *s3ImageObjectStore) Put(ctx context.Context, key string, data []byte, contentType string) error {
	if len(data) == 0 {
		return errors.New("image data is empty")
	}
	if len(data) > maxStoredImageBytes {
		return errors.New("image data is too large")
	}
	objectKey, err := s.objectKey(key)
	if err != nil {
		return err
	}
	_, err = s.client.PutObject(contextOrBackground(ctx), s.bucket, objectKey, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{
		ContentType: strings.TrimSpace(contentType),
	})
	if err != nil {
		return fmt.Errorf("upload image to S3: %w", err)
	}
	return nil
}

func (s *s3ImageObjectStore) Get(ctx context.Context, key string) ([]byte, string, error) {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return nil, "", err
	}
	object, err := s.client.GetObject(contextOrBackground(ctx), s.bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return nil, "", fmt.Errorf("read image from S3: %w", err)
	}
	defer object.Close()
	info, err := object.Stat()
	if err != nil {
		return nil, "", fmt.Errorf("stat image in S3: %w", err)
	}
	if info.Size < 1 || info.Size > maxStoredImageBytes {
		return nil, "", errors.New("stored image size is invalid")
	}
	data, err := io.ReadAll(io.LimitReader(object, maxStoredImageBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("download image from S3: %w", err)
	}
	if len(data) < 1 || len(data) > maxStoredImageBytes {
		return nil, "", errors.New("stored image size is invalid")
	}
	return data, strings.TrimSpace(info.ContentType), nil
}

func (s *s3ImageObjectStore) Delete(ctx context.Context, key string) error {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return err
	}
	if err := s.client.RemoveObject(contextOrBackground(ctx), s.bucket, objectKey, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("delete image from S3: %w", err)
	}
	return nil
}

func (s *s3ImageObjectStore) objectKey(key string) (string, error) {
	cleaned := path.Clean(strings.TrimSpace(key))
	if cleaned == "." || cleaned == "" || strings.HasPrefix(cleaned, "/") || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", errors.New("invalid object key")
	}
	if s.prefix == "" {
		return cleaned, nil
	}
	return s.prefix + "/" + cleaned, nil
}

func normalizeS3Endpoint(value string) (string, bool, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", false, errors.New("S3 endpoint is required")
	}
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", false, errors.New("S3 endpoint must be a valid http(s) URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false, errors.New("S3 endpoint must use http or https")
	}
	if parsed.User != nil || parsed.Path != "" && parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", false, errors.New("S3 endpoint must not contain user info, a path, query, or fragment")
	}
	return parsed.Host, parsed.Scheme == "https", nil
}

func normalizeObjectPrefix(value string) (string, error) {
	value = strings.Trim(strings.TrimSpace(value), "/")
	if value == "" {
		return "", nil
	}
	cleaned := path.Clean(value)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") || strings.Contains(cleaned, ":") {
		return "", errors.New("S3 prefix is invalid")
	}
	return cleaned, nil
}
