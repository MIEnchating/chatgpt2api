import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/use-my-assets.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

function setup() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const loads = [];
  const writes = [];
  const deletes = [];
  const react = {
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !dependencies.every((value, i) => Object.is(value, slots[index].dependencies[i]))) {
        slots[index] = { callback, dependencies };
      }
      return slots[index].callback;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
      effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { dependencies, cleanup: effect() };
      });
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, AbortController, DOMException,
    require(name) {
      if (name === "react") return react;
      if (name === "sonner") return { toast: { error() {} } };
      assert.equal(name, "@/lib/my-assets");
      return {
        fetchMyAssets(scope, signal) { const pending = deferred(); loads.push({ ...pending, scope, signal }); return pending.promise; },
        upsertMyAsset(asset, signal) { const pending = deferred(); writes.push({ ...pending, asset, signal }); return pending.promise; },
        deleteMyAsset(id, signal) { const pending = deferred(); deletes.push({ ...pending, id, signal }); return pending.promise; },
      };
    },
  });
  return {
    loads, writes, deletes,
    render(scope = "session-a", enabled = true) {
      cursor = 0; effects = [];
      const result = exports.useMyAssets(scope, enabled);
      effects.forEach((effect) => effect());
      return result;
    },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

const asset = (id, title = id) => ({ id, kind: "text", title, content: title, tags: [] });

test("a delayed initial asset snapshot preserves successful creations and updates", async () => {
  const state = setup();
  const hook = state.render();
  const create = hook.upsertAsset(asset("new"));
  const update = hook.upsertAsset(asset("existing", "edited"));
  await settle();
  state.writes.forEach((write) => write.resolve(write.asset));
  await Promise.all([create, update]);
  state.loads[0].resolve([asset("existing", "old"), asset("unmodified")]);
  await settle();
  const result = state.render();
  assert.deepEqual(Array.from(result.assets, ({ id, title }) => ({ id, title })), [
    { id: "existing", title: "edited" }, { id: "new", title: "new" }, { id: "unmodified", title: "unmodified" },
  ]);
  assert.equal(result.loading, false);
  state.unmount();
});

test("a delayed initial asset snapshot cannot restore a deleted asset", async () => {
  const state = setup();
  const hook = state.render();
  const deletion = hook.deleteAsset("removed");
  await settle();
  state.deletes[0].resolve(true);
  await deletion;
  state.loads[0].resolve([asset("removed"), asset("retained")]);
  await settle();
  assert.deepEqual(Array.from(state.render().assets, (item) => item.id), ["retained"]);
  state.unmount();
});

test("queued asset writes belong to the picker opening that enqueued them", async () => {
  const state = setup();
  const hook = state.render();
  state.loads[0].resolve([]);
  await settle();
  const first = hook.upsertAsset(asset("same", "first"));
  const queued = hook.upsertAsset(asset("same", "queued"));
  const outcomes = Promise.allSettled([first, queued]);
  await settle();
  assert.equal(state.writes.length, 1);
  state.render("session-a", false);
  state.render("session-a", true);
  assert.equal(state.writes[0].signal.aborted, true);
  state.loads[1].resolve([]);
  state.writes[0].reject(new DOMException("Picker closed", "AbortError"));
  await settle();
  assert.equal(state.writes.length, 1, "an old queued write must not dispatch with the new opening's signal");
  const result = await outcomes;
  assert.equal(result[1].status, "rejected");
  assert.equal(result[1].reason.name, "AbortError");
  assert.deepEqual(Array.from(state.render().assets), []);
  state.unmount();
});

test("writes after the initial snapshot continue to update the loaded list", async () => {
  const state = setup();
  const hook = state.render();
  state.loads[0].resolve([asset("retained")]);
  await settle();
  const creation = hook.upsertAsset(asset("new"));
  await settle();
  state.writes[0].resolve(asset("new"));
  await creation;
  assert.deepEqual(Array.from(state.render().assets, (item) => item.id), ["new", "retained"]);
  state.unmount();
});

test("failed asset writes do not override the initial server snapshot", async () => {
  const state = setup();
  const hook = state.render();
  const write = hook.upsertAsset(asset("existing", "failed edit"));
  const rejected = assert.rejects(write, /save failed/);
  await settle();
  state.writes[0].reject(new Error("save failed"));
  await rejected;
  state.loads[0].resolve([asset("existing", "server")]);
  await settle();
  assert.equal(state.render().assets[0].title, "server");
  state.unmount();
});

test("late writes from a closed picker cannot populate the reopened asset list", async () => {
  const state = setup();
  const hook = state.render();
  const write = hook.upsertAsset(asset("old"));
  await settle();
  state.render("session-a", false);
  state.render("session-a", true);
  state.writes[0].resolve(asset("old"));
  await write;
  state.loads[1].resolve([asset("current")]);
  state.loads[0].resolve([asset("stale")]);
  await settle();
  assert.deepEqual(Array.from(state.render().assets, (item) => item.id), ["current"]);
  state.unmount();
});
