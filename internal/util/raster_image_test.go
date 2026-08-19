package util

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/png"
	"testing"
)

func TestInspectRasterImage(t *testing.T) {
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 4, 3))); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	info, err := InspectRasterImage(data.Bytes(), "image/png")
	if err != nil {
		t.Fatalf("InspectRasterImage() error = %v", err)
	}
	if info.ContentType != "image/png" || info.Format != "png" || info.Width != 4 || info.Height != 3 {
		t.Fatalf("InspectRasterImage() = %#v", info)
	}
	if _, err := InspectRasterImage(data.Bytes(), "image/jpeg"); !errors.Is(err, ErrUnsupportedRasterImage) {
		t.Fatalf("disallowed format error = %v", err)
	}
}

func TestInspectRasterImageRejectsExcessiveDimensions(t *testing.T) {
	data := oversizedPNGHeader(65_536, 65_536)
	if _, err := InspectRasterImage(data); !errors.Is(err, ErrRasterImageTooLarge) {
		t.Fatalf("oversized dimensions error = %v", err)
	}
}

func oversizedPNGHeader(width, height uint32) []byte {
	data := make([]byte, 33)
	copy(data, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'})
	binary.BigEndian.PutUint32(data[8:12], 13)
	copy(data[12:16], "IHDR")
	binary.BigEndian.PutUint32(data[16:20], width)
	binary.BigEndian.PutUint32(data[20:24], height)
	data[24] = 8
	data[25] = 6
	binary.BigEndian.PutUint32(data[29:33], crc32.ChecksumIEEE(data[12:29]))
	return data
}
