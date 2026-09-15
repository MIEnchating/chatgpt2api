package service

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"os"
	"testing"
)

func thumbnailTransparencyFixture(t testing.TB, width, height int) []byte {
	t.Helper()
	source := image.NewNRGBA(image.Rect(0, 0, width, height))
	draw.Draw(source, image.Rect(width/3, 0, 2*width/3, height), image.NewUniform(color.NRGBA{R: 255, A: 128}), image.Point{}, draw.Src)
	draw.Draw(source, image.Rect(2*width/3, 0, width, height), image.NewUniform(color.NRGBA{B: 255, A: 255}), image.Point{}, draw.Src)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}

func TestImageThumbnailPreservesTransparentAndSemitransparentColors(t *testing.T) {
	service := NewImageService(testImageConfig{root: t.TempDir()})
	imageURL, err := service.SaveImageBytes(context.Background(), thumbnailTransparencyFixture(t, 1200, 600), "", "owner", "Owner")
	if err != nil {
		t.Fatal(err)
	}
	service.EnsureThumbnails([]string{imageURL})
	ref := service.imageFileRefs([]string{imageURL})[0]
	file, err := os.Open(service.thumbnailPath(ref.rel))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	thumbnail, err := jpeg.Decode(file)
	if err != nil {
		t.Fatal(err)
	}
	if thumbnail.Bounds().Dx() != 480 || thumbnail.Bounds().Dy() != 240 {
		t.Fatalf("thumbnail bounds = %v, want 480x240", thumbnail.Bounds())
	}
	for _, sample := range []struct {
		x    int
		want color.RGBA
	}{
		{x: 80, want: color.RGBA{R: 255, G: 255, B: 255, A: 255}},
		{x: 240, want: color.RGBA{R: 255, G: 127, B: 127, A: 255}},
		{x: 400, want: color.RGBA{B: 255, A: 255}},
	} {
		got := color.RGBAModel.Convert(thumbnail.At(sample.x, 120)).(color.RGBA)
		for channel, pair := range [][2]uint8{{got.R, sample.want.R}, {got.G, sample.want.G}, {got.B, sample.want.B}, {got.A, sample.want.A}} {
			if difference := int(pair[0]) - int(pair[1]); difference < -3 || difference > 3 {
				t.Fatalf("thumbnail at x=%d channel=%d = %v, want %v within JPEG tolerance", sample.x, channel, got, sample.want)
			}
		}
	}
}

func BenchmarkImageThumbnail4K(b *testing.B) {
	service := NewImageService(testImageConfig{root: b.TempDir()})
	imageURL, err := service.SaveImageBytes(context.Background(), thumbnailTransparencyFixture(b, 3840, 2160), "", "owner", "Owner")
	if err != nil {
		b.Fatal(err)
	}
	ref := service.imageFileRefs([]string{imageURL})[0]
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if result := service.generateThumbnail(ref); result["thumbnail_rel"] == nil {
			b.Fatal("thumbnail generation failed")
		}
	}
}
