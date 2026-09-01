package main

import (
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
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
	var production []string
	err := filepath.WalkDir(packageName, func(filename string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || filepath.Ext(filename) != ".go" || strings.HasSuffix(filename, "_test.go") {
			return nil
		}
		production = append(production, filename)
		return nil
	})
	return production, err
}

func TestProductionGoFilesIncludesNestedPackages(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	nested := filepath.Join(root, "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, filename := range []string{
		filepath.Join(root, "root.go"),
		filepath.Join(root, "root_test.go"),
		filepath.Join(nested, "nested.go"),
		filepath.Join(nested, "nested_test.go"),
		filepath.Join(nested, "notes.txt"),
	} {
		if err := os.WriteFile(filename, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	files, err := productionGoFiles(root)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(files)
	want := []string{filepath.Join(nested, "nested.go"), filepath.Join(root, "root.go")}
	slices.Sort(want)
	if !slices.Equal(files, want) {
		t.Fatalf("productionGoFiles() = %v, want %v", files, want)
	}
}

func TestArchitectureTestRunsFromInternalDirectory(t *testing.T) {
	if _, err := os.Stat("httpapi"); err != nil {
		t.Fatalf("architecture test working directory is not internal/: %v", err)
	}
}
