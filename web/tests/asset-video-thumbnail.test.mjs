import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/app/assets/asset-display.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function descendants(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(descendants)];
}

function setup() {
  let active;
  const observers = [];
  const react = {
    useState(initial) {
      const state = active;
      const index = state.cursor++;
      if (!(index in state.slots)) state.slots[index] = typeof initial === "function" ? initial() : initial;
      return [state.slots[index], (next) => { state.slots[index] = typeof next === "function" ? next(state.slots[index]) : next; }];
    },
    useRef(initial) {
      return active.slots[active.cursor++] ??= { current: initial };
    },
    useEffect(effect, dependencies) {
      const state = active;
      const index = state.cursor++;
      const previous = state.slots[index];
      if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
      state.effects.push(() => {
        previous?.cleanup?.();
        state.slots[index] = { dependencies, cleanup: effect() };
      });
    },
  };
  const exports = {};
  const jsx = (type, props, key) => ({ type, props, key });
  const placeholders = new Proxy({}, { get: (_, name) => String(name) });
  const context = {
    exports,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "@/app/assets/asset-library") return { assetModel: () => "", formatAssetCreatedTime: () => "" };
      return placeholders;
    },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.disconnected = true; }
      emit(isIntersecting) { this.callback([{ isIntersecting, target: this.target }]); }
    },
  };
  vm.runInNewContext(compiled, context);

  function mount(component, props) {
    const state = { slots: [], effects: [], cursor: 0 };
    const element = {};
    return {
      render() {
        active = state;
        state.cursor = 0;
        state.effects = [];
        const tree = typeof component === "function" ? component(props) : { type: component, props };
        for (const node of descendants(tree)) {
          if (node.props?.ref) node.props.ref.current = element;
        }
        for (const effect of state.effects) effect();
        return tree;
      },
      unmount() {
        for (const slot of state.slots) slot?.cleanup?.();
      },
    };
  }

  function card(src, eager = false) {
    const instance = mount(exports.AssetCard, {
      asset: { kind: "video", url: src, title: "Video", createdAt: "2026-09-14", visibility: "private" },
      eager,
      onOpen() {},
      onCopy() {},
      onDownload() {},
    });
    const thumbnail = descendants(instance.render()).find((node) => node.type === "video" || node.type?.name === "AssetVideoThumbnail");
    assert.ok(thumbnail, "the card should render a video thumbnail");
    return { thumbnail, instance: mount(thumbnail.type, thumbnail.props) };
  }

  return { observers, card };
}

test("lazy video thumbnails start loading metadata when they enter the viewport", () => {
  const { observers, card } = setup();
  const { instance } = card("/media/video.mp4");
  const offscreen = instance.render();
  assert.equal(offscreen.props.preload, "none");
  assert.equal(offscreen.props.src, undefined);
  assert.equal(observers.length, 1, "offscreen thumbnails need an observer to start loading when visible");
  const [observer] = observers;
  assert.ok(observer.target);
  observer.emit(false);
  assert.equal(instance.render().props.preload, "none");
  observer.emit(true);
  const visible = instance.render();
  assert.equal(visible.props.preload, "metadata");
  assert.equal(visible.props.src, "/media/video.mp4#t=0.1");
  assert.equal(observer.disconnected, true);
  assert.equal(observers.length, 1, "loaded thumbnails should not create a new observer");
  observer.emit(false);
  assert.equal(instance.render().props.preload, "metadata");
  instance.unmount();
});

test("eager video thumbnails load metadata immediately", () => {
  const { observers, card } = setup();
  const { instance } = card("/media/eager.mp4", true);
  const video = instance.render();
  assert.equal(video.props.preload, "metadata");
  assert.equal(video.props.src, "/media/eager.mp4#t=0.1");
  assert.equal(observers.length, 0);
  instance.unmount();
});

test("unmounting an offscreen thumbnail disconnects its observer", () => {
  const { observers, card } = setup();
  const { instance } = card("/media/removed.mp4");
  instance.render();
  assert.equal(observers.length, 1);
  assert.equal(observers[0].disconnected, false);
  instance.unmount();
  assert.equal(observers[0].disconnected, true);
});

test("changing the media source remounts the thumbnail with fresh visibility state", () => {
  const { observers, card } = setup();
  const first = card("/media/first.mp4");
  first.instance.render();
  assert.equal(observers.length, 1);
  observers[0].emit(true);
  assert.equal(first.instance.render().props.preload, "metadata");

  const second = card("/media/second.mp4");
  assert.notEqual(second.thumbnail.key, first.thumbnail.key, "React must discard the previous source's visibility state");
  const nextVideo = second.instance.render();
  assert.equal(nextVideo.props.preload, "none");
  assert.equal(nextVideo.props.src, undefined);
  first.instance.unmount();
  second.instance.unmount();
});
