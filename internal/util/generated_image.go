package util

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

// InspectGeneratedImage accepts raster output or static, self-contained SVG.
// SVG is never decoded as a raster image or accepted as an edit reference.
func InspectGeneratedImage(data []byte) (RasterImageInfo, error) {
	if len(data) > MaxRasterImageEncodedBytes {
		return RasterImageInfo{}, ErrRasterImageTooLarge
	}
	xmlData := bytes.TrimSpace(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}))
	if !bytes.HasPrefix(xmlData, []byte("<")) {
		return InspectRasterImage(data, "image/png", "image/jpeg", "image/webp", "image/gif")
	}
	decoder := xml.NewDecoder(bytes.NewReader(xmlData))
	allowed := "|svg|g|defs|path|rect|circle|ellipse|line|polyline|polygon|text|tspan|title|desc|linearGradient|radialGradient|stop|clipPath|mask|pattern|use|symbol|"
	attributes := "|id|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|width|height|viewBox|preserveAspectRatio|d|points|transform|fill|fill-rule|fill-opacity|stroke|stroke-width|stroke-linecap|stroke-linejoin|stroke-miterlimit|stroke-dasharray|stroke-dashoffset|stroke-opacity|opacity|clip-path|clip-rule|mask|maskUnits|maskContentUnits|clipPathUnits|gradientUnits|gradientTransform|spreadMethod|offset|stop-color|stop-opacity|fx|fy|fr|patternUnits|patternContentUnits|patternTransform|text-anchor|dominant-baseline|font-family|font-size|font-weight|font-style|letter-spacing|word-spacing|dx|dy|rotate|textLength|lengthAdjust|href|version|role|aria-label|style|"
	styleProperties := "|fill|fill-rule|fill-opacity|stroke|stroke-width|stroke-linecap|stroke-linejoin|stroke-dasharray|stroke-opacity|opacity|font-family|font-size|font-weight|font-style|text-anchor|dominant-baseline|"
	depth, roots := 0, 0
	info := RasterImageInfo{ContentType: "image/svg+xml", Format: "svg"}
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return RasterImageInfo{}, err
		}
		switch node := token.(type) {
		case xml.Directive:
			return RasterImageInfo{}, fmt.Errorf("SVG declarations are not allowed")
		case xml.ProcInst:
			if node.Target != "xml" || roots != 0 {
				return RasterImageInfo{}, fmt.Errorf("SVG processing instructions are not allowed")
			}
		case xml.StartElement:
			if (node.Name.Space != "" && node.Name.Space != "http://www.w3.org/2000/svg") || !strings.Contains(allowed, "|"+node.Name.Local+"|") {
				return RasterImageInfo{}, fmt.Errorf("unsupported SVG element %s", node.Name.Local)
			}
			if depth == 0 {
				roots++
				if roots != 1 || node.Name.Local != "svg" {
					return RasterImageInfo{}, ErrUnsupportedRasterImage
				}
			}
			depth++
			if depth > 128 {
				return RasterImageInfo{}, ErrRasterImageTooLarge
			}
			for _, attr := range node.Attr {
				if attr.Name.Local == "xmlns" || attr.Name.Space == "xmlns" {
					continue
				}
				if (attr.Name.Space != "" && attr.Name.Space != "http://www.w3.org/1999/xlink") || !strings.Contains(attributes, "|"+attr.Name.Local+"|") {
					return RasterImageInfo{}, fmt.Errorf("unsupported SVG attribute %s", attr.Name.Local)
				}
				value := strings.ToLower(strings.TrimSpace(attr.Value))
				if strings.ContainsAny(value, "\\@<>") || strings.Contains(value, "expression") || strings.Contains(value, "javascript:") {
					return RasterImageInfo{}, fmt.Errorf("unsafe SVG attribute")
				}
				for rest := value; strings.Contains(rest, "url("); {
					_, tail, _ := strings.Cut(rest, "url(")
					target, next, ok := strings.Cut(tail, ")")
					if !ok || !strings.HasPrefix(strings.Trim(strings.TrimSpace(target), "\"'"), "#") {
						return RasterImageInfo{}, fmt.Errorf("SVG external resources are not allowed")
					}
					rest = next
				}
				if attr.Name.Local == "href" && !strings.HasPrefix(value, "#") {
					return RasterImageInfo{}, fmt.Errorf("SVG external references are not allowed")
				}
				if attr.Name.Local == "style" {
					for _, declaration := range strings.Split(value, ";") {
						if strings.TrimSpace(declaration) == "" {
							continue
						}
						key, _, ok := strings.Cut(declaration, ":")
						if !ok || !strings.Contains(styleProperties, "|"+strings.TrimSpace(key)+"|") {
							return RasterImageInfo{}, fmt.Errorf("unsupported SVG style")
						}
					}
				}
				if depth == 1 {
					switch attr.Name.Local {
					case "width", "height":
						n, _ := strconv.ParseFloat(strings.TrimSuffix(value, "px"), 64)
						if n > 0 && n <= MaxRasterImageDimension && !math.IsNaN(n) {
							if attr.Name.Local == "width" {
								info.Width = int(math.Ceil(n))
							} else {
								info.Height = int(math.Ceil(n))
							}
						}
					case "viewBox":
						fields := strings.Fields(strings.ReplaceAll(value, ",", " "))
						if len(fields) == 4 {
							w, _ := strconv.ParseFloat(fields[2], 64)
							h, _ := strconv.ParseFloat(fields[3], 64)
							if info.Width == 0 && w > 0 && w <= MaxRasterImageDimension {
								info.Width = int(math.Ceil(w))
							}
							if info.Height == 0 && h > 0 && h <= MaxRasterImageDimension {
								info.Height = int(math.Ceil(h))
							}
						}
					}
				}
			}
		case xml.EndElement:
			depth--
		case xml.CharData:
			if depth == 0 && strings.TrimSpace(string(node)) != "" {
				return RasterImageInfo{}, ErrUnsupportedRasterImage
			}
		}
	}
	if roots != 1 || depth != 0 {
		return RasterImageInfo{}, ErrUnsupportedRasterImage
	}
	if err := ValidateRasterImageDimensions(info.Width, info.Height); err != nil {
		return RasterImageInfo{}, err
	}
	return info, nil
}
