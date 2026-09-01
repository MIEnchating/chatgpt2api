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
		"config":        {"chatgpt2api/internal/httpapi", "chatgpt2api/internal/protocol", "chatgpt2api/internal/service", "chatgpt2api/internal/videocontract", "chatgpt2api/internal/web"},
		"model":         {"chatgpt2api/internal"},
		"protocol":      {"chatgpt2api/internal/config", "chatgpt2api/internal/httpapi", "chatgpt2api/internal/service", "chatgpt2api/internal/storage", "chatgpt2api/internal/videocontract", "chatgpt2api/internal/web"},
		"service":       {"chatgpt2api/internal/config", "chatgpt2api/internal/httpapi", "chatgpt2api/internal/protocol", "chatgpt2api/internal/videocontract", "chatgpt2api/internal/web"},
		"storage":       {"chatgpt2api/internal/config", "chatgpt2api/internal/httpapi", "chatgpt2api/internal/protocol", "chatgpt2api/internal/service", "chatgpt2api/internal/videocontract", "chatgpt2api/internal/web"},
		"util":          {"chatgpt2api/internal"},
		"videocontract": {"chatgpt2api/internal/config", "chatgpt2api/internal/httpapi", "chatgpt2api/internal/service", "chatgpt2api/internal/web"},
		"web":           {"chatgpt2api/internal"},
	}
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == "httpapi" {
			continue
		}
		files, err := productionGoFiles(entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		if len(files) == 0 {
			continue
		}
		if _, ok := rules[entry.Name()]; !ok {
			t.Errorf("internal package %s has no dependency rule", entry.Name())
		}
	}

	for packageName, forbiddenImports := range rules {
		packageName := packageName
		forbiddenImports := forbiddenImports
		t.Run(packageName, func(t *testing.T) {
			t.Parallel()
			files, err := productionGoFiles(packageName)
			if err != nil {
				t.Fatal(err)
			}
			if len(files) == 0 {
				t.Fatalf("architecture rule for %s matched no production Go files", packageName)
			}
			for _, filename := range files {
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
						if forbiddenImportMatches(importPath, forbidden) {
							t.Errorf("%s imports higher layer %s", filename, importPath)
						}
					}
				}
			}
		})
	}
}

func forbiddenImportMatches(importPath, forbidden string) bool {
	forbidden = strings.TrimRight(forbidden, "/")
	return importPath == forbidden || strings.HasPrefix(importPath, forbidden+"/")
}

func TestForbiddenImportMatchesPackageTree(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		importPath string
		forbidden  string
		want       bool
	}{
		{name: "exact package", importPath: "chatgpt2api/internal/service", forbidden: "chatgpt2api/internal/service", want: true},
		{name: "nested package", importPath: "chatgpt2api/internal/storage/subpackage", forbidden: "chatgpt2api/internal", want: true},
		{name: "trailing slash rule", importPath: "chatgpt2api/internal/storage", forbidden: "chatgpt2api/internal/", want: true},
		{name: "similar prefix", importPath: "chatgpt2api/internalized/storage", forbidden: "chatgpt2api/internal", want: false},
		{name: "unrelated package", importPath: "example.com/internal/storage", forbidden: "chatgpt2api/internal", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := forbiddenImportMatches(test.importPath, test.forbidden); got != test.want {
				t.Fatalf("forbiddenImportMatches(%q, %q) = %v, want %v", test.importPath, test.forbidden, got, test.want)
			}
		})
	}
}

func productionGoFiles(packageName string) ([]string, error) {
	files, err := filepath.Glob(filepath.Join(packageName, "*.go"))
	if err != nil {
		return nil, err
	}
	production := files[:0]
	for _, filename := range files {
		if !strings.HasSuffix(filename, "_test.go") {
			production = append(production, filename)
		}
	}
	return production, nil
}

func TestArchitectureTestRunsFromInternalDirectory(t *testing.T) {
	if _, err := os.Stat("httpapi"); err != nil {
		t.Fatalf("architecture test working directory is not internal/: %v", err)
	}
}
