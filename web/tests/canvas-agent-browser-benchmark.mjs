import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { unzipSync } from "fflate";

// Run against the existing Vite source server with an isolated browser fixture.
// PLAYWRIGHT_MODULE can point to an existing Playwright installation.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseURL = process.env.CANVAS_BENCHMARK_URL || "http://127.0.0.1:8002";
const sampleCount = Number(process.env.CANVAS_BENCHMARK_SAMPLES || 3);
const screenshotDir = process.env.CANVAS_BENCHMARK_SCREENSHOTS;
assert.ok(Number.isInteger(sampleCount) && sampleCount > 0);
const turnCounts = (process.env.CANVAS_BENCHMARK_TURNS || "60,240").split(",").map(Number);
assert.ok(turnCounts.every(turns => Number.isSafeInteger(turns) && turns >= 40), "CANVAS_BENCHMARK_TURNS must contain integers of at least 40");
const stamp = "2026-11-22T21:00:00Z";
const project = "perf-fixture";
const state = { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] };
const frame = "流式进度 ";

function fixture(turns) {
  const messages = Array.from({ length: turns }, (_, index) => [
    { id: `u${index}`, role: "user", text: `创作要求 ${index + 1}`, status: "success" },
    { id: `a${index}`, role: "assistant", text: `分镜方案 ${index + 1}，保持场景连贯与商品细节。`, status: "success", replyToMessageID: `u${index}` },
  ]).flat();
  const next = { id: "live", role: "assistant", text: "", status: "running", replyToMessageID: "live-user" };
  const session = { id: "active", title: "广告分镜", createdAt: stamp, updatedAt: stamp, agentState: state, protocolMessages: [], engine: "native",
    messages: [...messages, { id: "live-user", role: "user", text: "继续检查镜头", status: "success" }, next] };
  return { id: project, version: 1, title: "性能基准画布", revision: 1, updated_at: stamp, nodes: [], connections: [],
    agent_sessions: [session], active_agent_session_id: session.id, agent_panel: { open: true, width: 420, mode: "docked" },
    agent_run: { id: "live-run", sessionId: session.id, assistantId: next.id, engine: "langgraph", status: "running", updatedAt: stamp } };
}

async function sample(turns) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const doc = fixture(turns);
    const members = [{ nodeId: "clip", title: "生成品牌短片", status: "running", progress: 37 }];
    doc.agent_sessions[0].messages.at(-1).workflowRuns = [{ id: "live-batch", status: "running", members }];
    await page.route(url => /^\/(api|auth)\//.test(url.pathname), async route => {
      const { pathname } = new URL(route.request().url());
      let body = { items: [], config: {}, preferences: {} };
      if (pathname === "/auth/session") body = { credential_id: "mock-benchmark-session", role: "admin", subject_id: "benchmark", name: "性能基准", menus: [] };
      if (pathname === "/api/model-config") body = { config: { image_models: [], audio_models: [], text_models: ["model"], video_models: [], video_model_contracts: [], image_model_definitions: [] } };
      if (pathname === "/api/canvas") body = { document: doc, projects: [{ id: doc.id, title: doc.title, revision: doc.revision }], active_project_id: doc.id };
      await route.fulfill({ json: body });
    });
    await page.addInitScript(({ doc, frame }) => {
      const fetch = window.fetch.bind(window);
      let begin;
      const gate = new Promise(resolve => { begin = resolve; });
      window.beginBenchmarkStream = begin;
      window.benchmarkSamples = { inputAt: null, inputOverlapped: false, ended: false };
      document.addEventListener("input", event => {
        if (window.benchmarkSamples.inputAt !== null || !event.isTrusted || !event.target.closest('[contenteditable="true"][role="textbox"]')) return;
        window.benchmarkSamples.inputAt = performance.now();
        window.benchmarkSamples.inputOverlapped = !window.benchmarkSamples.ended;
      });
      window.fetch = (request, options) => {
        const url = new URL(request instanceof Request ? request.url : request, location.href);
        if (url.pathname !== "/api/canvas/agent-runs" || url.searchParams.get("run_id") !== doc.agent_run.id) return fetch(request, options);
        const encoder = new TextEncoder();
        const push = (controller, payload) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        return Promise.resolve(new Response(new ReadableStream({
          async start(controller) {
            push(controller, { type: "snapshot", document: doc });
            await gate;
            const index = doc.agent_sessions[0].messages.length - 1;
            for (let i = 0; i < 60; i++) {
              await new Promise(resolve => setTimeout(resolve, 32));
              const operations = [{ path: ["revision"], value: i + 2 }, {
                path: ["agent_sessions", 0, "messages", index, "text"], value: frame, append: true,
              }];
              if (i === 59) {
                operations.push({ path: ["agent_run", "status"], value: "success" }, {
                  path: ["agent_sessions", 0, "messages", index, "status"], value: "success",
                }, {
                  path: ["agent_sessions", 0, "messages", index, "workflowRuns", 0],
                  value: { id: "live-batch", status: "success", members: [{ nodeId: "clip", title: "生成品牌短片", status: "success" }] },
                });
                window.benchmarkSamples.ended = true;
              }
              push(controller, { type: "delta", base_revision: i + 1, revision: i + 2, operations });
            }
            controller.close();
          },
        }), { headers: { "Content-Type": "text/event-stream" } }));
      };
    }, { doc, frame });
    const painted = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    let started = performance.now();
    await page.goto(`${baseURL}/canvas/${project}`, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-agent-message="a${turns - 1}"]`).waitFor();
    await painted();
    const openMs = performance.now() - started;

    const earlierMs = [];
    for (let oldest = turns - 39; oldest > -20; oldest -= 20) {
      const button = page.getByRole("button", { name: "更早回合", exact: true });
      await button.waitFor();
      started = performance.now();
      await button.click();
      await page.locator(`[data-agent-message="a${Math.max(0, oldest)}"]`).waitFor();
      await painted();
      earlierMs.push(performance.now() - started);
      if (oldest <= 0) break;
    }
    assert.equal(await page.getByRole("button", { name: "更早回合", exact: true }).count(), 0);
    await page.getByRole("button", { name: "回到最新", exact: true }).click();
    const workflow = page.locator('[data-agent-workflow-run="live-batch"]');
    await workflow.getByText("生成中 37%", { exact: true }).waitFor();
    const editor = page.locator('[data-agent-composer-scroll] [contenteditable="true"][role="textbox"]');
    await editor.focus();
    const streamStarted = await page.evaluate(() => {
      window.beginBenchmarkStream();
      return performance.now();
    });
    await page.getByText(frame.trim(), { exact: false }).first().waitFor();
    const firstFrameAt = await page.evaluate(() => performance.now());
    await page.keyboard.type("draft during stream");
    const input = await page.evaluate(() => window.benchmarkSamples);
    assert.ok(input.inputOverlapped, "trusted input must arrive before the terminal stream frame");
    await page.waitForFunction(() => window.benchmarkSamples.ended);
    await page.locator('[data-agent-message="live"]').waitFor();
    await workflow.getByRole("progressbar", { name: "工作流完成进度" }).waitFor();
    assert.equal(await workflow.getByRole("progressbar", { name: "工作流完成进度" }).getAttribute("aria-valuetext"), "已完成 1 项，共 1 项");
    assert.match(await editor.innerText(), /draft during stream/);
    return { openMs, earlierMs, slowestEarlierMs: Math.max(...earlierMs), firstFrameMs: firstFrameAt - streamStarted, inputAfterFrameMs: input.inputAt - firstFrameAt, browserVersion: browser.version() };
  } finally {
    await browser.close();
  }
}

async function assertDisclosure(button, open) {
  assert.equal(await button.getAttribute("aria-expanded"), String(open));
  const direction = await button.locator("svg path").evaluate(path => {
    const length = path.getTotalLength();
    const matrix = path.getScreenCTM();
    const [start, tip, end] = [0, length / 2, length].map(distance => path.getPointAtLength(distance).matrixTransform(matrix));
    const dx = tip.x - (start.x + end.x) / 2;
    const dy = tip.y - (start.y + end.y) / 2;
    return dx > Math.abs(dy) ? "right" : dy > Math.abs(dx) ? "down" : "unexpected";
  });
  assert.equal(direction, open ? "down" : "right", `${await button.innerText()} arrow`);
}

async function verifyCanvasActions() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce", colorScheme: "dark" });
    const doc = fixture(60);
    delete doc.agent_run;
    doc.agent_sessions[0].title = "验收 · 蓝调灯塔｜15 秒品牌短片";
    doc.nodes = [
      { id: "text", type: "text", title: "交付文案", prompt: "交付正文", x: 0, y: 0, width: 240, height: 120 },
      { id: "image", type: "image", title: "封面", url: "/api/test-cover", x: 300, y: 0, width: 240, height: 120 },
    ];
    const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNqkAAAAASUVORK5CYII=", "base64");
    const failedReply = doc.agent_sessions[0].messages.at(-3);
    Object.assign(failedReply, {
      status: "error", elapsedMs: 89000, text: "分镜和画面参考已写入画布。视频生成失败，服务端要求提供参考图。",
      workflowRuns: [{ id: "partial-batch", status: "error", members: [
        { nodeId: "text", title: "整理三段式分镜", status: "success" },
        { nodeId: "image", title: "准备首帧视觉参考", status: "success" },
        { nodeId: "video", title: "生成 15 秒品牌短片", status: "error" },
      ] }],
      canvasChanges: [{ id: "text", kind: "node", action: "added", label: "整理三段式分镜" }],
    });
    const reply = doc.agent_sessions[0].messages.at(-1);
    Object.assign(reply, { status: "success", text: "已完成封面设计。请查收交付物。", deliverableNodeIds: ["text", "image"], workflowRuns: [
      { id: "failed-batch", status: "error", members: [{ nodeId: "image", title: "之前的封面", status: "error" }, { nodeId: "text", title: "依赖文案", status: "skipped" }] },
    ], canvasChanges: [
      { id: "image", kind: "node", action: "added", label: "封面" },
      { id: "old-link", kind: "connection", action: "removed", label: "已移除的参考连线" },
    ] });
    const historyQueries = [];
    let feedbackConflict = false;
    let feedbackHistoryReads = 0;
    const feedbackVersions = [];
    await page.route(url => /^\/(api|auth)\//.test(url.pathname), async route => {
      const request = route.request();
      const { pathname, searchParams } = new URL(request.url());
      assert.ok(!(pathname === "/api/canvas/agent-runs" && request.method() === "POST"), "fixture actions must not start a model run");
      if (pathname === "/api/test-cover") return route.fulfill({ contentType: "image/png", body: original });
      let body = { items: [], config: {}, preferences: {} };
      if (pathname === "/auth/session") body = { credential_id: "mock-benchmark-session", role: "admin", subject_id: "benchmark", name: "性能基准", menus: [] };
      if (pathname === "/api/canvas") {
        if (feedbackConflict && request.method() === "GET" && searchParams.get("history") === "active" && searchParams.get("session_id") === doc.active_agent_session_id) feedbackHistoryReads++;
        body = { document: doc, projects: [{ id: doc.id, title: doc.title, revision: doc.revision }], active_project_id: doc.id };
      }
      if (pathname === "/api/canvas/agent-feedback") {
        const submitted = request.postDataJSON();
        assert.equal(submitted.messageId, reply.id);
        assert.equal(submitted.feedback.note, "保留我的反馈草稿");
        feedbackVersions.push(submitted.ifVersion);
        if (submitted.ifVersion === "another-tab") {
          doc.revision += 1;
          reply.feedback = { ...submitted.feedback, version: "saved-retry", createdAt: stamp, updatedAt: stamp };
          return route.fulfill({ json: { document: doc } });
        }
        assert.equal(submitted.ifVersion, "");
        feedbackConflict = true;
        doc.revision += 1;
        reply.feedback = { rating: "negative", version: "another-tab", note: "其他页面的反馈", createdAt: stamp, updatedAt: stamp };
        return route.fulfill({
          status: 409,
          json: { error: { code: "feedback_version_conflict", message: "该消息的反馈已在其他页面更新，请重新打开反馈" }, document: doc },
        });
      }
      if (pathname === "/api/canvas/agent-history") {
        historyQueries.push(Object.fromEntries(searchParams));
        const scoped = searchParams.get("in_session") === doc.active_agent_session_id;
        const nextPage = searchParams.has("cursor");
        const role = searchParams.get("role") || "assistant";
        body = { revision: doc.revision, matches: [{
          session_id: scoped ? doc.active_agent_session_id : "previous",
          title: scoped ? "广告分镜" : "旧分镜",
          message_id: nextPage ? "p2" : "p1",
          role,
          snippet: scoped ? "当前对话的冷色方案" : nextPage ? "第二页的冷色建议" : "沿用冷色拍摄方案",
        }], next_cursor: !scoped && !nextPage ? "all-page-2" : undefined };
      }
      await route.fulfill({ json: body });
    });
    await page.goto(`${baseURL}/canvas/${project}`, { waitUntil: "domcontentloaded" });
    const changes = page.getByRole("button", { name: /本轮改动（2）/ });
    const removedLink = page.getByText("已移除的参考连线", { exact: true });
    await changes.waitFor();
    await assertDisclosure(changes, false);
    assert.equal(await removedLink.isVisible(), false);
    if (screenshotDir) await changes.locator("..").screenshot({ path: `${screenshotDir}/canvas-agent-changes-closed.png` });
    await changes.click();
    await assertDisclosure(changes, true);
    await removedLink.waitFor();
    await removedLink.evaluate(element => new Promise((resolve, reject) => {
      const observer = new IntersectionObserver(([entry]) => {
        observer.disconnect();
        if (entry.isIntersecting) resolve();
        else reject(new Error("Expanded changes are outside the conversation viewport"));
      });
      observer.observe(element);
    }));
    if (screenshotDir) await changes.locator("..").screenshot({ path: `${screenshotDir}/canvas-agent-changes-open.png` });
    await changes.press("Space");
    await assertDisclosure(changes, false);
    await removedLink.waitFor({ state: "hidden" });
    const panel = page.getByRole("complementary", { name: "Agent 对话面板" });
    const partial = panel.locator('[data-agent-workflow-run="partial-batch"]');
    const partialToggle = partial.getByRole("button", { name: /工作流进度/ });
    const partialProgress = partial.getByRole("progressbar", { name: "工作流完成进度" });
    const failedNode = partial.getByRole("button", { name: "生成 15 秒品牌短片" });
    await failedNode.waitFor();
    await assertDisclosure(partialToggle, true);
    if (screenshotDir) await partial.screenshot({ path: `${screenshotDir}/canvas-agent-workflow-open.png` });
    await partialToggle.press("Space");
    await failedNode.waitFor({ state: "hidden" });
    await assertDisclosure(partialToggle, false);
    if (screenshotDir) await partial.screenshot({ path: `${screenshotDir}/canvas-agent-workflow-closed.png` });
    assert.equal(await partialProgress.getAttribute("aria-valuetext"), "已完成 2 项，共 3 项");
    await partialToggle.click();
    await failedNode.waitFor();
    await assertDisclosure(partialToggle, true);
    const scrollToPartial = () => partial.evaluate(element => element.scrollIntoView({ block: "start" }));
    if (screenshotDir) {
      await scrollToPartial();
      await panel.screenshot({ path: `${screenshotDir}/canvas-agent-progress-desktop.png` });
    }
    const editor = page.locator('[data-agent-composer-scroll] [contenteditable="true"][role="textbox"]');
    await editor.fill("当前创作要求");
    await page.getByRole("button", { name: "历史记录", exact: true }).click();
    await page.getByPlaceholder("搜索历史消息").fill("冷色");
    await page.getByRole("button", { name: "更多结果", exact: true }).click();
    await page.getByText("第二页的冷色建议", { exact: true }).waitFor();
    await page.getByRole("combobox", { name: "历史消息搜索范围" }).click();
    await page.getByRole("option", { name: "当前对话", exact: true }).click();
    await page.getByText("当前对话的冷色方案", { exact: true }).waitFor();
    assert.equal(await page.getByText("第二页的冷色建议", { exact: true }).count(), 0);
    await page.getByRole("combobox", { name: "历史消息角色" }).click();
    await page.getByRole("option", { name: "用户消息", exact: true }).click();
    await page.getByText("当前对话的冷色方案", { exact: true }).waitFor();
    const baseQuery = { project_id: doc.id, q: "冷色" };
    assert.deepEqual(historyQueries, [
      baseQuery,
      { ...baseQuery, cursor: "all-page-2" },
      { ...baseQuery, in_session: doc.active_agent_session_id },
      { ...baseQuery, in_session: doc.active_agent_session_id, role: "user" },
    ]);
    await page.getByRole("combobox", { name: "历史消息搜索范围" }).click();
    await page.getByRole("option", { name: "全部对话", exact: true }).click();
    await page.getByRole("button", { name: "引用「旧分镜」的搜索片段" }).click();
    await editor.waitFor();
    assert.match(await editor.innerText(), /当前创作要求[\s\S]*引用自「旧分镜」[\s\S]*沿用冷色拍摄方案/);
    const message = page.locator('[data-agent-message="live"]');
    await message.getByText("已完成封面设计。请查收交付物。").evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode();
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 7);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await message.getByRole("button", { name: "引用到输入框" }).click();
    const draft = await editor.innerText();
    assert.match(draft, /已完成封面设计/);
    assert.doesNotMatch(draft, /请查收交付物/);
    const batch = page.locator('[data-agent-workflow-run="failed-batch"]');
    await batch.getByText("未执行", { exact: true }).waitFor();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "下载本轮成品" }).click(),
    ]);
    assert.equal(download.suggestedFilename(), "本轮成品.zip");
    const files = unzipSync(await readFile(await download.path()));
    assert.deepEqual(Object.keys(files), ["1-交付文案.txt", "2-封面.png"]);
    assert.equal(Buffer.from(files["1-交付文案.txt"]).toString(), "交付正文");
    assert.deepEqual(Buffer.from(files["2-封面.png"]), original);
    await page.reload({ waitUntil: "domcontentloaded" });
    await batch.getByText("未执行", { exact: true }).waitFor();
    await message.getByRole("button", { name: "回复有帮助", exact: true }).click();
    const feedbackDialog = page.getByRole("dialog", { name: "回复有帮助" });
    const feedbackNote = feedbackDialog.getByLabel("补充说明（可选）");
    await feedbackNote.fill("保留我的反馈草稿");
    await feedbackDialog.getByRole("button", { name: "保存反馈" }).click();
    await feedbackDialog.getByRole("button", { name: "基于最新版本继续" }).click();
    assert.equal(await feedbackNote.inputValue(), "保留我的反馈草稿");
    assert.deepEqual(feedbackVersions, [""]);
    await feedbackDialog.getByRole("button", { name: "保存反馈" }).click();
    await feedbackDialog.waitFor({ state: "hidden" });
    assert.deepEqual(feedbackVersions, ["", "another-tab"]);
    assert.equal(await message.getByRole("button", { name: "回复有帮助", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(feedbackHistoryReads, 0);
    await page.setViewportSize({ width: 390, height: 720 });
    await scrollToPartial();
    const narrowBounds = await panel.evaluate(element => {
      const toolbar = element.querySelector("[data-canvas-agent-toolbar]").getBoundingClientRect();
      const send = element.querySelector('[data-agent-send]').getBoundingClientRect();
      const scroll = element.querySelector('[data-agent-message-scroll]');
      return { toolbarRight: toolbar.right, sendRight: send.right, sendBottom: send.bottom, scrollWidth: scroll.scrollWidth, viewportWidth: scroll.clientWidth };
    });
    assert.ok(narrowBounds.toolbarRight <= 390 && narrowBounds.sendRight <= 390 && narrowBounds.sendBottom <= 720);
    assert.equal(narrowBounds.scrollWidth, narrowBounds.viewportWidth);
    if (screenshotDir) await panel.screenshot({ path: `${screenshotDir}/canvas-agent-progress-mobile.png` });
  } finally {
    await browser.close();
  }
}

async function verifyAgentStarter() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    let doc = { id: "canvas-starter-fixture", version: 1, title: "验收画布", revision: 1, updated_at: stamp, nodes: [], connections: [] };
    const model = { text: ["text-default", "text-selected"], image: ["image-default", "image-selected"], video: ["video-default", "video-selected"] };
    const prompt = "为海盐香氛规划一套主视觉和短片分镜。";
    let saved;
    await page.route(url => /^\/(api|auth)\//.test(url.pathname), async route => {
      const request = route.request();
      const { pathname, searchParams } = new URL(request.url());
      let body = { items: [], config: {}, preferences: {} };
      if (pathname === "/auth/session") body = { credential_id: "mock-benchmark-session", role: "admin", subject_id: "benchmark", name: "画布验收", menus: [] };
      if (pathname === "/api/profile/image-generation-preferences") body = { preferences: { default_text_model: model.text[0], default_text_relay_token_names: ["fixture"] } };
      if (pathname === "/api/profile/upstream-models") body = { data: Object.values(model).flat().map(id => ({ id })) };
      if (pathname === "/api/profile/assets") body = { items: [{ id: "brief", kind: "text", title: "品牌简报", content: "冷色海岸，低饱和视觉。", owned: true }] };
      if (pathname === "/api/profile/agent-skills") body = { items: [{ id: "storyboard", name: "广告分镜", enabled: true, scope: "personal" }] };
      if (pathname === "/api/model-config") body = { config: { text_models: model.text, image_models: model.image, video_models: model.video, audio_models: [], video_model_contracts: [], image_model_definitions: [] } };
      if (pathname === "/api/canvas") {
        if (request.method() === "PUT") {
          const change = request.postDataJSON();
          if (!saved && change.pending_agent_request) saved = change;
          doc = { ...change, revision: doc.revision + 1 };
        }
        body = searchParams.get("view") === "projects" ? { projects: [], active_project_id: "" } : { document: doc, projects: [{ id: doc.id, title: doc.title, revision: doc.revision }], active_project_id: doc.id };
      }
      if (pathname === "/api/canvas/agent-runs" && request.method() === "POST") {
        const run = request.postDataJSON();
        doc = { ...doc, revision: doc.revision + 1, agent_run: { id: run.id, sessionId: run.sessionId, assistantId: run.assistantId, engine: "langgraph", status: "success", updatedAt: stamp } };
        body = { document: doc };
      }
      await route.fulfill({ json: body });
    });
    await page.goto(`${baseURL}/canvas`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    const starter = page.getByRole("dialog", { name: "Agent", exact: true });
    await starter.getByRole("button", { name: "Agent 对话模型" }).click();
    await page.getByRole("option", { name: model.text[1] }).click();
    await starter.getByRole("button", { name: "图片和视频模型" }).click();
    await page.getByRole("button", { name: "图片模型", exact: true }).click();
    await page.getByRole("option", { name: model.image[1] }).click();
    await page.getByRole("button", { name: "视频模型", exact: true }).click();
    await page.getByRole("option", { name: model.video[1] }).click();
    const input = starter.getByRole("textbox", { name: "描述创作目标" });
    await input.fill(prompt);
    await starter.getByRole("button", { name: "创作技能" }).click();
    await page.getByRole("button", { name: /广告分镜/ }).click();
    await page.keyboard.press("Escape");
    await starter.getByRole("button", { name: "添加 Agent 素材" }).click();
    await page.getByRole("menuitem", { name: "我的素材" }).click();
    await page.getByRole("button", { name: "插入素材：品牌简报" }).click();
    await starter.getByRole("button", { name: "移除附件 品牌简报" }).waitFor();
    if (screenshotDir) await starter.screenshot({ path: `${screenshotDir}/canvas-agent-starter.png` });
    const submitted = page.waitForRequest(request => new URL(request.url()).pathname === "/api/canvas/agent-runs" && request.method() === "POST");
    await input.press("Enter");
    const run = (await submitted).postDataJSON();
    await page.waitForURL("**/canvas/starter-fixture");
    assert.equal(saved.pending_agent_request.prompt, prompt);
    assert.equal(saved.pending_agent_request.assets[0].payload.content, "冷色海岸，低饱和视觉。");
    assert.deepEqual([saved.agent_config.textModel, saved.agent_config.imageModel, saved.agent_config.videoModel], [model.text[1], model.image[1], model.video[1]]);
    assert.deepEqual([run.userText, run.model, run.generation.imageModel, run.generation.videoModel], [prompt, model.text[1], model.image[1], model.video[1]]);
    assert.deepEqual(run.skillIds, ["storyboard"]);
    assert.deepEqual(run.references, [{ id: saved.pending_agent_request.assets[0].reference.id, source: "attachment" }]);
  } finally {
    await browser.close();
  }
}

const metrics = ["openMs", "slowestEarlierMs", "firstFrameMs", "inputAfterFrameMs"];
const results = [];
for (const turns of turnCounts) {
  const samples = [];
  for (let index = 0; index < sampleCount; index++) samples.push(await sample(turns));
  const median = Object.fromEntries(metrics.map(metric => {
    const values = samples.map(sample => sample[metric]).sort((left, right) => left - right);
    return [metric, (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2];
  }));
  results.push({ turns, documentBytes: Buffer.byteLength(JSON.stringify(fixture(turns))), samples, median });
}
console.log(JSON.stringify({ node: process.version, platform: platform(), arch: arch(), results }, null, 2));
await verifyCanvasActions();
await verifyAgentStarter();
console.log("Browser verified workflow progress, narrow Agent layout, collapsible changes, historical excerpts, deliverable ZIP, feedback conflicts, and starter model handoff.");
