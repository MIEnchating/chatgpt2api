import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const html = readFileSync(new URL("../public/director/index.html", import.meta.url), "utf8");
const entry = html.match(/src="(\/director\/assets\/[^"]+\.js)"/);
assert.ok(entry, "Director HTML must reference its current script bundle");
const source = readFileSync(new URL(`../public${entry[1]}`, import.meta.url), "utf8");
const parsed = ts.createSourceFile("director.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declarations = new Map(parsed.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name.text, node.getText(parsed)]));

test("the shipped director bundle parses completely", () => {
  assert.equal(parsed.parseDiagnostics.length, 0);
});

test("pasting director objects only remaps camera targets in the pasted copy", () => {
  const helpers = ["Ws", "eE", "ZC", "tE", "KC", "fB"].map((name) => declarations.get(name)).join("\n");
  const paste = new Function("qU", "uh", "Em", "Nc", `${helpers}; return fB;`)(
    0.6, (label, index) => `${label}${index}`, (object) => object.transform.position, (camera, patch) => ({ ...camera, ...patch }),
  );
  const transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  const character = { id: "actor", kind: "character", name: "Actor", transform };
  const camera = { id: "camera", targetMode: "object", targetObjectId: "actor", transform, target: [0, 1, 0] };
  const cameraObject = { id: "camera-object", kind: "camera", linkedCameraId: "camera", transform };
  for (const copied of [[character, cameraObject], [cameraObject, character]]) {
    const result = paste({
      project: { objects: [character, cameraObject], cameras: [camera], activeCameraId: "camera" },
      clipboard: copied.map((object) => ({ object, ...(object.kind === "camera" ? { camera } : {}) })), clipboardPasteCount: 0,
    });
    assert.equal(result.project.cameras[0], camera);
    const pastedCharacter = result.project.objects.find((item) => item.kind === "character" && item.id !== "actor");
    assert.equal(result.project.cameras[1].targetObjectId, pastedCharacter.id);
    assert.deepEqual(result.project.cameras[1].target, pastedCharacter.transform.position);
  }
});
