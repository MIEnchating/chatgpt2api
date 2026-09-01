import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(webRoot, "src");
const frontendLayers = ["lib", "services", "store", "components", "app"];

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(filename);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [filename] : [];
  }));
  return nested.flat();
}

function importedModules(source, filename) {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const modules = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      modules.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1
      && ts.isStringLiteralLike(node.arguments[0])) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = node.arguments.length === 1
        && ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamicImport || requireCall) {
        modules.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return modules;
}

function resolveFrontendModule(filename, moduleName) {
  if (moduleName.startsWith("@/")) {
    return path.join(srcRoot, moduleName.slice(2));
  } else if (moduleName.startsWith(".")) {
    return path.resolve(path.dirname(filename), moduleName);
  }
  return null;
}

function frontendLayer(filename) {
  const relative = path.relative(srcRoot, filename);
  if (relative.startsWith("..")) return null;
  const layer = relative.split(path.sep)[0];
  const rank = frontendLayers.indexOf(layer);
  return rank < 0 ? null : { layer, rank };
}

function resolvesIntoApp(filename, moduleName) {
  return frontendLayer(resolveFrontendModule(filename, moduleName) || "")?.layer === "app";
}

test("frontend boundary scanner covers static, dynamic, and relative imports", () => {
  const filename = path.join(webRoot, "src/lib/example.ts");
  const source = `
    import "@/app/side-effect";
    export { value } from "@/app/re-export";
    const dynamicValue = import("../app/dynamic");
    const templateDynamicValue = import(\`../app/template-dynamic\`);
    const attributedDynamicValue = import("../app/data.json", { with: { type: "json" } });
    const requiredValue = require("../app/required");
  `;
  const modules = importedModules(source, filename);
  assert.deepEqual(modules, [
    "@/app/side-effect",
    "@/app/re-export",
    "../app/dynamic",
    "../app/template-dynamic",
    "../app/data.json",
    "../app/required",
  ]);
  assert.equal(modules.every((moduleName) => resolvesIntoApp(filename, moduleName)), true);
  assert.equal(resolvesIntoApp(filename, "@/components/button"), false);
});

test("frontend layers only import their own or lower layers", async () => {
  const violations = [];
  for (const layer of frontendLayers.slice(0, -1)) {
    const root = path.join(srcRoot, layer);
    for (const filename of await sourceFiles(root)) {
      const source = await readFile(filename, "utf8");
      const importer = frontendLayer(filename);
      for (const moduleName of importedModules(source, filename)) {
        const dependency = frontendLayer(resolveFrontendModule(filename, moduleName) || "");
        if (importer && dependency && dependency.rank > importer.rank) {
          violations.push(`${path.relative(webRoot, filename)} -> ${moduleName}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("media storage is server-backed and never writes browser databases", async () => {
  for (const relative of ["src/services/image-storage.ts", "src/services/file-storage.ts"]) {
    const source = await readFile(path.join(webRoot, relative), "utf8");
    assert.doesNotMatch(source, /localforage|indexedDB|createInstance|\.setItem\s*\(/);
    assert.match(source, /@\/services\/api\/storage/);
  }
  const storageAPI = await readFile(path.join(webRoot, "src/services/api/storage.ts"), "utf8");
  assert.doesNotMatch(storageAPI, /localforage|indexedDB|createInstance|\.setItem\s*\(/);
  assert.match(storageAPI, /\/api\/files/);
  const shell = await readFile(path.join(webRoot, "src/app/app-shell.tsx"), "utf8");
  assert.doesNotMatch(shell, /storage-migration|migrateLocalAssetsToCloud/);
});

test("global dialogs use the shared scroll area instead of native scrollbars", async () => {
  const source = await readFile(path.join(webRoot, "src/components/ui/dialog.tsx"), "utf8");
  assert.match(source, /import \{ ScrollArea \} from "@\/components\/ui\/scroll-area"/);
  assert.match(source, /scrollable \? \(/);
  assert.doesNotMatch(source, /overflow-y-auto/);
});

test("global overlays never autofocus when opened", async () => {
  const dialog = await readFile(path.join(webRoot, "src/components/ui/dialog.tsx"), "utf8");
  const popover = await readFile(path.join(webRoot, "src/components/ui/popover.tsx"), "utf8");
  const imageLightbox = await readFile(path.join(webRoot, "src/components/image-lightbox.tsx"), "utf8");
  const canvasVideoPlayer = await readFile(path.join(webRoot, "src/app/canvas/canvas-video-player.tsx"), "utf8");

  for (const source of [dialog, popover]) {
    assert.match(source, /"onOpenAutoFocus"/);
    assert.match(source, /onOpenAutoFocus=\{\(event\) => event\.preventDefault\(\)\}/);
  }
  assert.match(imageLightbox, /onOpenAutoFocus=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.doesNotMatch(canvasVideoPlayer, /useEffect/);
  assert.doesNotMatch(canvasVideoPlayer, /previousFocus/);

  const autoFocusViolations = [];
  const openAutoFocusViolations = [];
  const allowedOpenAutoFocus = new Set([
    "src/components/image-lightbox.tsx",
    "src/components/ui/dialog.tsx",
    "src/components/ui/popover.tsx",
  ]);
  for (const filename of await sourceFiles(path.join(webRoot, "src"))) {
    const source = await readFile(filename, "utf8");
    const relative = path.relative(webRoot, filename);
    if (/\bautoFocus\b/.test(source)) autoFocusViolations.push(relative);
    if (/onOpenAutoFocus/.test(source) && !allowedOpenAutoFocus.has(relative)) openAutoFocusViolations.push(relative);
  }
  assert.deepEqual(autoFocusViolations, []);
  assert.deepEqual(openAutoFocusViolations, []);
});
