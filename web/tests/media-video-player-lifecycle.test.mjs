import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/media-video-player.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function setup({ fail = false } = {}) {
  let effect;
  let imports = 0;
  let instances = 0;
  let destroyed = 0;
  const errors = [];
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === "react") return { useRef: () => ({ current: {} }), useEffect: (callback) => { effect = callback; } };
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }) };
      if (name === "@/lib/utils") return { cn: () => "" };
      if (name === "sonner") return { toast: { error: (message) => errors.push(message) } };
      if (name === "xgplayer/dist/index.min.css") return {};
      if (name === "xgplayer") {
        imports++;
        if (fail) throw new Error("module unavailable");
        return { default: class {
          constructor() { instances++; }
          destroy() { destroyed++; }
        } };
      }
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return {
    render(src = "/video.mp4") { exports.MediaVideoPlayer({ src }); },
    mount() { return effect(); },
    counts: () => ({ imports, instances, destroyed }),
    errors,
  };
}

test("importing the player wrapper does not load the playback library", () => {
  const player = setup();
  player.render("");
  player.mount();
  assert.equal(player.counts().imports, 0);
});

test("a disposed player cannot initialize after its deferred import resolves", async () => {
  const player = setup();
  player.render();
  const dispose = player.mount();
  dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(player.counts().instances, 0);
});

test("mounted players initialize once and release their instance", async () => {
  const player = setup();
  player.render();
  const dispose = player.mount();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(player.counts().instances, 1);
  dispose();
  assert.equal(player.counts().destroyed, 1);
});

test("a failed library download is handled without an unhandled rejection", async () => {
  const player = setup({ fail: true });
  player.render();
  const dispose = player.mount();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(player.errors.length, 1);
  assert.equal(player.counts().instances, 0);
  dispose();
});
