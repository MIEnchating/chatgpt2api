import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function hooks() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const react = {
    forwardRef: (render) => render,
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useMemo: (create) => create(),
    useCallback: (callback) => callback,
    useEffect: (effect) => { effects.push(effect); },
    useLayoutEffect: () => {},
    useImperativeHandle: () => {},
    useSyncExternalStore: (_, snapshot) => snapshot(),
  };
  return {
    react,
    get effects() { return effects; },
    render(component, props = {}) {
      cursor = 0;
      effects = [];
      return component(props);
    },
  };
}

function loadSource(path, imports = {}, globals = {}, extra = "") {
  const source = readFileSync(new URL(path, import.meta.url), "utf8") + extra;
  const output = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const jsx = (type, props, key) => ({ type, props, key });
  const placeholders = new Proxy({}, { get: (_, name) => String(name) });
  vm.runInNewContext(output, {
    exports,
    require(name) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "@/lib/utils") return { cn: (...values) => values.filter(Boolean).join(" ") };
      return imports[name] ?? placeholders;
    },
    ...globals,
  }, { filename: path });
  return exports;
}

function descendants(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(descendants)];
}

function event(target, currentTarget = target, key = "ArrowDown") {
  return { target, currentTarget, key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class KeyboardTarget {
  constructor(control = false, editable = false) { this.control = control; this.isContentEditable = editable; }
  closest() { return this.control ? this : null; }
}

test("scroll containers preserve editing keys and consumer cancellation", () => {
  for (const mode of ["input", "editable", "cancelled", "consumer", "plain"]) {
    const state = hooks();
    const { ScrollArea } = loadSource("../src/components/ui/scroll-area.tsx", { react: state.react }, { HTMLElement: KeyboardTarget, Element: KeyboardTarget });
    let consumerCalls = 0;
    const root = state.render(ScrollArea, { onKeyDown(e) { consumerCalls++; if (mode === "consumer") e.preventDefault(); } });
    let scrollCalls = 0;
    root.props.children[0].props.ref({ scrollTo() { scrollCalls++; } });
    const target = new KeyboardTarget(mode === "input", mode === "editable");
    const e = event(target);
    if (mode === "cancelled") e.preventDefault();
    root.props.onKeyDown(e);
    assert.equal(e.defaultPrevented, mode === "plain" || mode === "cancelled" || mode === "consumer", mode);
    assert.equal(consumerCalls, 1, mode);
    assert.equal(scrollCalls, mode === "plain" ? 1 : 0, mode);
  }
});

test("read-only number inputs cannot be changed with step controls", () => {
  const state = hooks();
  const { NumberInput } = loadSource("../src/components/ui/number-input.tsx", { react: state.react });
  const changes = [];
  const tree = state.render(NumberInput, { value: 2, readOnly: true, onValueChange: (value) => changes.push(value) });
  const input = descendants(tree).find((item) => item.type === "input");
  let steps = 0;
  input.props.ref({ value: "3", readOnly: true, focus() {}, stepUp() { steps++; }, stepDown() { steps++; } });
  const buttons = descendants(tree).filter((item) => item.props?.tooltip);
  assert.equal(buttons.length, 2);
  for (const button of buttons) {
    button.props.onClick();
    assert.equal(button.props.disabled, true);
  }
  assert.equal(steps, 0);
  assert.equal(changes.length, 0);
});

test("multi-select preserves keyboard activation of nested remove buttons", () => {
  const state = hooks();
  const { MultiSelect } = loadSource("../src/components/ui/multi-select.tsx", { react: state.react });
  const tree = state.render(MultiSelect, { value: ["one"], options: [{ value: "one", label: "One" }], onValueChange() {} });
  const trigger = descendants(tree).find((item) => item.props?.role === "combobox");
  const nestedButton = {};
  for (const key of ["Enter", " "]) {
    const e = event(nestedButton, trigger, key);
    trigger.props.onKeyDown(e);
    assert.equal(e.defaultPrevented, false, key);
  }
  const e = event(trigger, trigger, "Enter");
  trigger.props.onKeyDown(e);
  assert.equal(e.defaultPrevented, true);
});

test("queue refreshes cannot delete histories after unmount or supersession", async () => {
  for (const staleKind of ["unmount", "superseded", "current"]) {
    const state = hooks();
    const requests = [];
    const deletions = [];
    const listeners = new Map();
    const { useImageConversationsForQueue } = loadSource("../src/components/image-task-queue.tsx", {
      react: state.react,
      "@/lib/image-conversation-source": { isWorkflowImageConversation: () => true },
      "@/store/image-conversations": {
        loadImageConversationHistoryWindow() { const request = deferred(); requests.push(request); return request.promise; },
        mergeImageConversationItems: (first, active) => [...first, ...active],
        deleteImageConversation: async (id) => { deletions.push(id); },
      },
    }, { window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {} } }, "\nexport { useImageConversationsForQueue };\n");
    state.render(useImageConversationsForQueue);
    const cleanup = state.effects[0]();
    if (staleKind === "unmount") cleanup();
    if (staleKind === "superseded") listeners.get("focus")();
    requests[0].resolve({ firstPage: { items: [{ id: "workflow-history" }] }, activePage: { items: [] } });
    await flush();
    assert.deepEqual(deletions, staleKind === "current" ? ["workflow-history"] : [], staleKind);
    cleanup();
  }
});

test("login image fallback stops retrying when the fallback itself fails", () => {
  const state = hooks();
  const { useLoginPageImageState } = loadSource("../src/components/use-login-page-image-state.ts", {
    react: state.react,
    "@/lib/app-meta": { DEFAULT_LOGIN_PAGE_IMAGE: "/fallback.svg", resolveLoginPageImageSrc: (value) => value || "/fallback.svg" },
    "@/lib/login-page-image-layout": { normalizeLoginPageImageMode: (value) => value, normalizeLoginPageImageTransform: (value) => value, getLoginPageImageLayout: () => null },
  });
  let retries = 0;
  const target = { get src() { return "https://app.example/fallback.svg"; }, set src(_) { retries++; } };
  const props = { src: "/custom.png", mode: "contain", zoom: 1, positionX: 50, positionY: 50 };
  let result = state.render(useLoginPageImageState, props);
  result.onImageError({ currentTarget: target });
  result = state.render(useLoginPageImageState, props);
  assert.equal(result.currentSrc, "/fallback.svg");
  result.onImageError({ currentTarget: target });
  assert.equal(retries, 0, "React should own src changes; a failed fallback must not be assigned repeatedly");
});

test("announcement effect replay starts a fresh load and applies its response", async () => {
  const state = hooks();
  const requests = [];
  const lifecycle = loadSource("../src/lib/announcement-lifecycle.ts");
  const mutations = loadSource("../src/lib/scoped-mutation-lifecycle.ts");
  const { AnnouncementCenter } = loadSource("../src/components/announcement-center.tsx", {
    react: state.react,
    "@/lib/announcement-lifecycle": lifecycle,
    "@/lib/scoped-mutation-lifecycle": mutations,
    "@/lib/api": {
      fetchAnnouncements() { const request = deferred(); requests.push(request); return request.promise; },
      fetchAnnouncementPreferences: async () => ({ preferences: { seen_versions: [], permanent_versions: [], snoozed_dates: {} } }),
    },
  }, { window: { addEventListener() {}, removeEventListener() {}, setInterval() { return 1; }, clearInterval() {} }, document: { addEventListener() {}, removeEventListener() {} } });
  state.render(AnnouncementCenter, { sessionKey: "session-a" });
  const setup = state.effects[0];
  setup()();
  const cleanup = setup();
  assert.equal(requests.length, 2, "replayed effect reused a load invalidated by cleanup");
  requests[0].resolve({ items: [{ id: "old", updated_at: "1", title: "old" }] });
  requests[1].resolve({ items: [{ id: "new", updated_at: "2", title: "new" }] });
  await flush();
  const tree = state.render(AnnouncementCenter, { sessionKey: "session-a" });
  const serialized = JSON.stringify(tree);
  assert.ok(serialized.includes('"new"'));
  assert.ok(!serialized.includes('"old"'));
  cleanup();
});

test("task queue state is remounted when the active session changes", () => {
  const state = hooks();
  let session = { key: "session-a", role: "user" };
  const listeners = new Map();
  const { TopNav } = loadSource("../src/components/top-nav.tsx", {
    react: state.react,
    "react-router-dom": { useLocation: () => ({ pathname: "/studio" }), useNavigate: () => () => {} },
    "@/lib/session": { getCachedAuthSession: () => session },
    "@/lib/auth-session": { canAccessPath: () => true, AUTH_SESSION_CHANGE_EVENT: "session-change" },
    "@/lib/use-app-meta": { useAppMeta: () => ({ app_title: "Test" }) },
    "@/lib/app-meta": { resolveSiteIconSrc: () => "/icon.svg" },
    "@/lib/theme": { getPreferredColorTheme: () => "light" },
  }, { window: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener() {} } });
  const queue = descendants(state.render(TopNav)).find((item) => item.type === "ImageTaskQueue");
  assert.equal(queue.key, session.key);
  const cleanup = state.effects[1]();
  session = { key: "session-b", role: "user" };
  listeners.get("session-change")();
  const nextQueue = descendants(state.render(TopNav)).find((item) => item.type === "ImageTaskQueue");
  assert.equal(nextQueue.key, session.key);
  assert.notEqual(nextQueue.key, queue.key);
  cleanup();
});

test("opening queued work still navigates when browser storage is unavailable", () => {
  const state = hooks();
  let firstState = true;
  const navigations = [];
  const events = [];
  const { ImageTaskQueue } = loadSource("../src/components/image-task-queue.tsx", {
    react: { ...state.react, useState(initial) {
      if (firstState) {
        firstState = false;
        return state.react.useState([{ id: "conversation", title: "Work", turns: [{ id: "turn", images: [], createdAt: "2026-01-01", count: 1 }] }]);
      }
      return state.react.useState(initial);
    } },
    "react-router-dom": { useNavigate: () => (path) => navigations.push(path) },
    "@/store/image-conversations": {
      getEffectiveImageTurnStatus: () => "queued",
      getImageTurnLoadingCounts: () => ({ queued: 1, running: 0 }),
      ACTIVE_IMAGE_CONVERSATION_STORAGE_KEY: "active",
      IMAGE_ACTIVE_CONVERSATION_REQUEST_EVENT: "open-conversation",
    },
    "@/store/image-turn-progress": { getImageTurnProgressSnapshot: () => ({}) },
    "@/store/canvas-task-queue": { getCanvasTaskQueueSnapshot: () => [] },
  }, {
    window: { localStorage: { setItem() { throw new Error("storage denied"); } }, dispatchEvent: (e) => events.push(e) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  });
  const tree = state.render(ImageTaskQueue);
  const queuedItem = descendants(tree).find((item) => item.type?.name === "QueueItem");
  queuedItem.props.onOpenConversation("conversation");
  assert.deepEqual(navigations, ["/studio"]);
  assert.equal(events[0].type, "open-conversation");
  assert.equal(events[0].detail.conversationId, "conversation");
});

test("navigation session verification handles network rejection", async () => {
  const state = hooks();
  let attempts = 0;
  const { TopNav } = loadSource("../src/components/top-nav.tsx", {
    react: state.react,
    "react-router-dom": { useLocation: () => ({ pathname: "/studio" }), useNavigate: () => () => {} },
    "@/lib/session": {
      getCachedAuthSession: () => null,
      async getVerifiedAuthSession() { attempts++; throw new Error("network unavailable"); },
    },
    "@/lib/use-app-meta": { useAppMeta: () => ({}) },
    "@/lib/theme": { getPreferredColorTheme: () => "light" },
  });
  state.render(TopNav);
  const cleanup = state.effects[0]();
  await flush();
  assert.equal(attempts, 1);
  cleanup();
});
