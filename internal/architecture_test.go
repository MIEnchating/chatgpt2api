package main

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestInternalPackageDependencyDirection(t *testing.T) {
	t.Parallel()
	rules := map[string][]string{
		"model":    {"chatgpt2api/internal/"},
		"storage":  {"chatgpt2api/internal/httpapi", "chatgpt2api/internal/protocol", "chatgpt2api/internal/service"},
		"service":  {"chatgpt2api/internal/backend", "chatgpt2api/internal/config", "chatgpt2api/internal/httpapi", "chatgpt2api/internal/protocol", "chatgpt2api/internal/web"},
		"backend":  {"chatgpt2api/internal/config", "chatgpt2api/internal/httpapi", "chatgpt2api/internal/model", "chatgpt2api/internal/protocol", "chatgpt2api/internal/service", "chatgpt2api/internal/storage", "chatgpt2api/internal/web"},
		"protocol": {"chatgpt2api/internal/config", "chatgpt2api/internal/httpapi", "chatgpt2api/internal/web"},
	}

	for packageName, forbiddenImports := range rules {
		packageName := packageName
		forbiddenImports := forbiddenImports
		t.Run(packageName, func(t *testing.T) {
			t.Parallel()
			files, err := filepath.Glob(filepath.Join(packageName, "*.go"))
			if err != nil {
				t.Fatal(err)
			}
			for _, filename := range files {
				if strings.HasSuffix(filename, "_test.go") {
					continue
				}
				parsed, err := parser.ParseFile(token.NewFileSet(), filename, nil, parser.ImportsOnly)
				if err != nil {
					t.Fatalf("parse %s: %v", filename, err)
				}
				for _, spec := range parsed.Imports {
					importPath, err := strconv.Unquote(spec.Path.Value)
					if err != nil {
						t.Fatalf("unquote import in %s: %v", filename, err)
					}
					for _, forbidden := range forbiddenImports {
						if importPath == forbidden || strings.HasPrefix(importPath, forbidden+"/") {
							t.Errorf("%s imports higher layer %s", filename, importPath)
						}
					}
				}
			}
		})
	}
}

func TestArchitectureTestRunsFromInternalDirectory(t *testing.T) {
	if _, err := os.Stat("httpapi"); err != nil {
		t.Fatalf("architecture test working directory is not internal/: %v", err)
	}
}
