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

function importedModules(source, filename, runtimeOnly = false) {
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
      if (runtimeOnly) {
        if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
        if (ts.isImportDeclaration(node) && node.importClause) {
          if (node.importClause.isTypeOnly) return;
          const bindings = node.importClause.namedBindings;
          if (!node.importClause.name && bindings && ts.isNamedImports(bindings)
            && bindings.elements.length > 0 && bindings.elements.every((binding) => binding.isTypeOnly)) return;
        }
      }
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

function independentModelSelectors(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Map();
  const namespaces = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) names.set(binding.name.text, binding.propertyName?.text || binding.name.text);
    }
  }
  function modelValue(expression) {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return modelValue(expression.expression);
    if (ts.isIdentifier(expression)) return /(?:^model$|Model$|_model$)/.test(expression.text);
    if (ts.isPropertyAccessExpression(expression)) return modelValue(expression.name);
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression)) return /(?:^model$|Model$|_model$)/.test(expression.argumentExpression.text);
    if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expression.operatorToken.kind)) return modelValue(expression.left) || modelValue(expression.right);
    if (ts.isConditionalExpression(expression)) return modelValue(expression.whenTrue) || modelValue(expression.whenFalse);
    return false;
  }
  const violations = [];
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(ast);
      const [namespace, symbol] = tag.split(".");
      const name = names.get(tag) || (namespaces.has(namespace) ? symbol : tag);
      if (["Select", "DropdownMenuRadioGroup", "RadioGroup"].includes(name)) {
        const value = node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.text === "value")?.initializer;
        if (value && ts.isJsxExpression(value) && value.expression && modelValue(value.expression)) {
          violations.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
        }
      }
      if (name === "CommandInput" && node.attributes.getText(ast).includes("搜索模型")) {
        violations.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return violations;
}

test("model selector scanner distinguishes model choices from capability fields", () => {
  const source = `import { Select as Choice } from "@/components/ui/select";
    import { RadioGroup as ModelRadio } from "@/components/ui/radio-group";
    import * as Menu from "@/components/ui/dropdown-menu";
    <><Choice value={model} /><Choice value={agent.model} /><Choice value={importModel} />
    <Choice value={node.generation_model || defaultModel} /><Choice value={preferences["default_text_model"]} />
    <ModelRadio value={enabled ? agent.model : ""} /><Menu.DropdownMenuRadioGroup value={config.video_model ?? ""} />
    <Choice value={capabilities?.[model] || kind} /><Choice value={ratio} /><ModelPicker value={model} /></>`;
  assert.equal(independentModelSelectors(source, "fixture.tsx").length, 7);
});

test("model choices use the shared AI Elements selector across all application surfaces", async () => {
  const violations = [];
  for (const filename of await sourceFiles(path.join(srcRoot, "app"))) {
    if (!filename.endsWith(".tsx")) continue;
    const source = await readFile(filename, "utf8");
    for (const line of independentModelSelectors(source, filename)) violations.push({ file: path.relative(srcRoot, filename), line });
  }
  assert.deepEqual(violations, [], "Reuse ModelPicker and its AI Elements Model Selector instead of independent model menus");
});

test("AI replies share one Markdown renderer across application surfaces", async () => {
  const allowed = new Set([
    "components/ai-elements/message.tsx",
    "lib/markdown-translations.ts",
  ]);
  const violations = [];
  for (const filename of await sourceFiles(srcRoot)) {
    const source = await readFile(filename, "utf8");
    const relative = path.relative(srcRoot, filename).split(path.sep).join("/");
    if (importedModules(source, filename, true).includes("streamdown") && !allowed.has(relative)) violations.push(relative);
  }
  assert.deepEqual(violations, [], "Use the shared AI Elements MessageResponse for AI replies");
});

function independentPromptInputs(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const controls = new Set();
  const namespaces = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const resolved = resolveFrontendModule(filename, statement.moduleSpecifier.text);
    if (!["textarea", "input"].some(name => resolved === path.join(srcRoot, "components/ui", name))) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (["Textarea", "Input"].includes(binding.propertyName?.text || binding.name.text)) controls.add(binding.name.text);
      }
    }
  }
  const promptFields = new Set(["prompt", "system_prompt", "video_system_prompt", "audio_instructions", "negative_prompt", "prompt_instruction", "image_prompt", "video_prompt", "batchAppend"]);
  const violations = [];
  function promptValue(expression) {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return promptValue(expression.expression);
    if (ts.isPropertyAccessExpression(expression)) return promptFields.has(expression.name.text);
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression)) return promptFields.has(expression.argumentExpression.text);
    if (ts.isIdentifier(expression)) return promptFields.has(expression.text);
    if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expression.operatorToken.kind)) return promptValue(expression.left) || promptValue(expression.right);
    if (ts.isConditionalExpression(expression)) return promptValue(expression.whenTrue) || promptValue(expression.whenFalse);
    return false;
  }
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(ast);
      const [namespace, name] = tag.split(".");
      if (controls.has(tag) || namespaces.has(namespace) && ["Textarea", "Input"].includes(name)) {
        const attr = name => node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.text === name)?.initializer;
        const readOnly = attr("readOnly");
        const readOnlyAttribute = node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.text === "readOnly");
        const staticReadOnly = Boolean(readOnlyAttribute && (!readOnly || ts.isJsxExpression(readOnly) && readOnly.expression?.kind === ts.SyntaxKind.TrueKeyword));
        const value = attr("value");
        if (!staticReadOnly && value && ts.isJsxExpression(value) && value.expression && promptValue(value.expression)) {
          violations.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return violations;
}

test("prompt input scanner follows imported aliases and values without treating stored documents as prompts", () => {
  const filename = path.join(srcRoot, "app/profile/fixture.tsx");
  const source = `import { Textarea as Text } from "@/components/ui/textarea";
    import * as Fields from "../../components/ui/input";
    <><Text value={preferences.system_prompt} /><Text value={preferences.video_system_prompt || ""} />
    <Text value={preferences["audio_instructions"]} /><Fields.Input value={prompt} />
    <Text value={enabled ? config.negative_prompt : ""} /><Text readOnly={false} value={prompt} />
    <Text readOnly value={prompt} /><Text readOnly={true} value={prompt} />
    <Text value={draft.content} /><Text value={config.description} /><Text value={previewInput} />
    <PromptInput><InputGroupTextarea value={prompt} /></PromptInput></>`;
  assert.equal(independentPromptInputs(source, filename).length, 6);
});

test("editable AI instruction fields use the shared prompt input across application surfaces", async () => {
  const violations = [];
  for (const filename of await sourceFiles(srcRoot)) {
    if (!filename.endsWith(".tsx") || filename.includes(`${path.sep}components${path.sep}ui${path.sep}`)) continue;
    const source = await readFile(filename, "utf8");
    for (const line of independentPromptInputs(source, filename)) violations.push({ file: path.relative(srcRoot, filename), line });
  }
  assert.deepEqual(violations, [], "Reuse AI Elements PromptInput and InputGroupTextarea for editable AI instructions");
});

function sharedControlViolations(source, filename) {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const loadingIcons = new Set();
  const lucideNamespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== "lucide-react") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) lucideNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (/^Loader(?:2|Circle)(?:Icon)?$/.test(binding.propertyName?.text || binding.name.text)) loadingIcons.add(binding.name.text);
      }
    }
  }
  const violations = [];
  const visit = node => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      const attribute = name => node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.text === name)?.initializer;
      const fileInput = tag === "input" && attribute("type") && ts.isStringLiteral(attribute("type")) && attribute("type").text === "file";
      const role = attribute("role");
      const simulatedControl = /^[a-z]/.test(tag) && role && ts.isStringLiteral(role)
        && ["button", "combobox", "checkbox", "switch", "radio", "listbox", "option"].includes(role.text);
      const nativeControl = ["label", "textarea", "select", "progress", "meter", "details", "summary", "kbd", "fieldset", "legend"].includes(tag) || (tag === "input" && !fileInput) || simulatedControl;
      const [namespace, symbol] = tag.split(".");
      const loadingIcon = loadingIcons.has(tag) || (lucideNamespaces.has(namespace) && /^Loader(?:2|Circle)(?:Icon)?$/.test(symbol || ""));
      if (nativeControl || loadingIcon) violations.push({ tag, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "createElement" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && ["button", "input", "textarea", "select", "progress", "meter", "label", "fieldset", "legend"].includes(node.arguments[0].text)) {
      violations.push({ tag: node.arguments[0].text, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

test("shared control scanner follows loading icon aliases and keeps native file inputs", () => {
  const source = `
    import { LoaderCircle as BusyIcon } from "lucide-react";
    import * as Icons from "lucide-react";
    <><BusyIcon /><Icons.Loader2Icon /><label /><textarea /><select /><input type="text" /><progress /><fieldset /><legend /><article role="button" /><div role="combobox" /></>;
    <><input type="file" hidden /><Spinner /><Label /><Textarea /><Select /><Progress /><FieldSet /><FieldLegend /></>;
    document.createElement("button");
    document.createElement("span");
  `;
  assert.deepEqual(sharedControlViolations(source, "example.tsx").map(item => item.tag), [
    "BusyIcon", "Icons.Loader2Icon", "label", "textarea", "select", "input", "progress", "fieldset", "legend", "article", "div", "button",
  ]);
});

test("application surfaces reuse shared controls, loading indicators and AI message composition", async () => {
  const violations = [];
  for (const filename of await sourceFiles(srcRoot)) {
    const relative = path.relative(srcRoot, filename).split(path.sep).join("/");
    if (relative.startsWith("components/ui/") || relative.startsWith("components/ai-elements/")) continue;
    const source = await readFile(filename, "utf8");
    if (filename.endsWith(".tsx")) {
      violations.push(...sharedControlViolations(source, filename).map(item => ({ file: relative, ...item })));
    }
    for (const moduleName of importedModules(source, filename, true)) {
      if (resolveFrontendModule(filename, moduleName) === path.join(srcRoot, "components/ui/message")) {
        violations.push({ file: relative, moduleName });
      }
    }
  }
  assert.deepEqual(violations, [], "Reuse shared shadcn controls and AI Elements message composition; file input and canvas coordinate interactions stay native");
});

function tooltipStateConflicts(source, filename) {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const binding of statement.importClause.namedBindings.elements) {
      names.set(binding.name.text, binding.propertyName?.text || binding.name.text);
    }
  }
  const stateOwners = new Set([
    "Switch", "Checkbox", "Toggle", "ToggleGroupItem", "RadioGroupItem", "TabsTrigger",
    "SelectTrigger", "PopoverTrigger", "DropdownMenuTrigger", "DialogTrigger", "CollapsibleTrigger",
  ]);
  const conflicts = [];
  const tagName = (node) => {
    const name = node.tagName.getText(sourceFile);
    return names.get(name) || name;
  };
  const checkAnchor = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const component = tagName(opening);
      if (stateOwners.has(component)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        conflicts.push({ filename, line, component });
      }
      // A real wrapper owns the tooltip state; do not descend into its children.
      return;
    }
    ts.forEachChild(node, checkAnchor);
  };
  const visit = (node) => {
    if (ts.isJsxElement(node) && ["TooltipHint", "TooltipTrigger"].includes(tagName(node.openingElement))) {
      node.children.forEach(checkAnchor);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return conflicts;
}

test("tooltip state scanner follows aliases, fragments, and conditional anchors", () => {
  const direct = `
    import { Switch as EnableSwitch } from "@/components/ui/switch";
    <TooltipHint content="Enable"><EnableSwitch checked /></TooltipHint>;
    <TooltipTrigger asChild>{ready ? <PopoverTrigger asChild><button /></PopoverTrigger> : <span />}</TooltipTrigger>;
    <TooltipHint content="Select"><><Toggle pressed /></></TooltipHint>;
  `;
  assert.deepEqual(tooltipStateConflicts(direct, "example.tsx").map((item) => item.component), [
    "Switch", "PopoverTrigger", "Toggle",
  ]);
  const isolated = `
    <TooltipHint content="Enable"><span><Switch checked /></span></TooltipHint>;
    <TooltipTrigger asChild><span><PopoverTrigger asChild><button /></PopoverTrigger></span></TooltipTrigger>;
  `;
  assert.deepEqual(tooltipStateConflicts(isolated, "example.tsx"), []);
});

test("tooltip anchors preserve state owned by controls and popup triggers", async () => {
  const conflicts = [];
  for (const filename of await sourceFiles(srcRoot)) {
    if (!filename.endsWith(".tsx")) continue;
    conflicts.push(...tooltipStateConflicts(await readFile(filename, "utf8"), path.relative(srcRoot, filename)));
  }
  assert.deepEqual(conflicts, [], "Tooltip state must not replace checked, pressed, or popup state on the same DOM element");
});

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
  assert.deepEqual(importedModules(`
    import type { Components } from "streamdown";
    import { type StreamdownProps } from "streamdown";
    import { Streamdown } from "streamdown";
  `, filename, true), ["streamdown"]);
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
          violations.push(`${path.relative(webRoot, filename).split(path.sep).join("/")} -> ${moduleName}`);
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

test("media uploads use storage-service metadata instead of decoding files again in app views", async () => {
  const canvas = await readFile(path.join(webRoot, "src/app/canvas/page.tsx"), "utf8");
  const assetForm = await readFile(path.join(webRoot, "src/app/assets/asset-form.tsx"), "utf8");
  const assetMedia = await readFile(path.join(webRoot, "src/app/assets/asset-media.ts"), "utf8");

  for (const source of [canvas, assetForm, assetMedia]) {
    assert.doesNotMatch(source, /createImageBitmap|createObjectURL\(file\)|onloadedmetadata/);
  }
  assert.doesNotMatch(canvas, /videoFileMetadata|imageFileSize|audioFileDuration/);
  assert.doesNotMatch(assetForm, /inspectAssetFile/);
});

test("dialogs compose their scrolling body explicitly", async () => {
  const source = await readFile(path.join(webRoot, "src/components/ui/dialog.tsx"), "utf8");
  assert.match(source, /DialogPrimitive\.Content/);
  assert.doesNotMatch(source, /flattenDialogChildren|scrollable/);
});

test("global overlays keep focus out of editable controls while dialogs receive focus", async () => {
  const dialog = await readFile(path.join(webRoot, "src/components/ui/dialog.tsx"), "utf8");
  const popover = await readFile(path.join(webRoot, "src/components/ui/popover.tsx"), "utf8");
  const imageLightbox = await readFile(path.join(webRoot, "src/components/image-lightbox.tsx"), "utf8");
  const canvasVideoPlayer = await readFile(path.join(webRoot, "src/app/canvas/canvas-video-player.tsx"), "utf8");

  assert.match(popover, /onOpenAutoFocus/);
  assert.match(popover, /onOpenAutoFocus=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\)/);
  for (const source of [dialog, imageLightbox]) {
    assert.match(source, /tabIndex=\{-1\}/);
    assert.match(source, /onOpenAutoFocus=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\);\s*\(event\.currentTarget as HTMLElement\)\.focus\(\{ preventScroll: true \}\)/);
  }
  const videoPreview = canvasVideoPlayer.slice(canvasVideoPlayer.indexOf("export function CanvasVideoPreview"));
  assert.doesNotMatch(videoPreview, /useEffect/);
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
    const relative = path.relative(webRoot, filename).split(path.sep).join("/");
    if (/\bautoFocus\b/.test(source)) autoFocusViolations.push(relative);
    if (/onOpenAutoFocus/.test(source) && !allowedOpenAutoFocus.has(relative)) openAutoFocusViolations.push(relative);
  }
  assert.deepEqual(autoFocusViolations, []);
  assert.deepEqual(openAutoFocusViolations, []);
});
