import assert from "node:assert/strict";
import test from "node:test";
import { formatModelPricing, hydrateModelPriceQuotes, mergeModelPriceQuotes, modelPriceQuotesFromResponses } from "../src/lib/model-pricing.ts";

test("cached prices fill an empty state after asynchronous Key selection", () => {
  const cached = { video: [{ tokenName: "video-key", displayName: "video-key", text: "$3/次" }] };
  assert.deepEqual(hydrateModelPriceQuotes({}, cached).video, cached.video);
});

test("late cache responses preserve fresh prices and fill missing models and Keys", () => {
  const quote = (tokenName, text) => ({ tokenName, displayName: tokenName, text });
  const current = { video: [quote("a", "new")] };
  const cached = { video: [quote("a", "old"), quote("b", "cached")], image: [quote("a", "cached")] };
  const hydrated = hydrateModelPriceQuotes(current, cached);
  assert.deepEqual(hydrated.video, [quote("a", "new"), quote("b", "cached")]);
  assert.deepEqual(hydrated.image, cached.image);
  assert.deepEqual(current.video, [quote("a", "new")]);
});

test("refresh replaces successful key quotes and preserves failed key quotes", () => {
  const quote = (tokenName, text) => ({ tokenName, displayName: tokenName, text });
  const current = { shared: [quote("a", "old"), quote("b", "retained")], removed: [quote("a", "old")] };
  const updated = { shared: [quote("a", "new")], added: [quote("a", "new")] };
  const merged = mergeModelPriceQuotes(current, updated, ["a"]);
  assert.deepEqual(merged.shared, [quote("b", "retained"), quote("a", "new")]);
  assert.equal(merged.removed, undefined);
  assert.deepEqual(merged.added, [quote("a", "new")]);
});

test("dynamic price tiers are split without losing conditions", () => {
  const pricing = { currency: "USD", mode: "dynamic", rates: [
    { label: "resolution = 480P · count", amount: 1, unit: "count" },
    { label: "非(resolution = 480P) 且 resolution = 768P · count", amount: 1.2, unit: "count" },
    { label: "非(resolution = 480P) 且 非(resolution = 768P) · count", amount: 1.8, unit: "count" },
  ] };
  assert.equal(formatModelPricing(pricing), "分辨率 480P $1/个\n分辨率 768P $1.2/个\n其他 $1.8/个");
  pricing.rates[1].label = "非(resolution = 480P) 且 duration = 10 · count";
  assert.match(formatModelPricing(pricing), /非\(分辨率 480P\) 且 duration = 10 · count/);
});

test("dynamic per-second resolution tiers hide redundant seconds labels", () => {
  const pricing = { currency: "USD", mode: "dynamic", rates: [
    { label: "resolution = 480p · seconds", amount: 0.025, unit: "second" },
    { label: "非(resolution = 480p) 且 resolution = 720p · seconds", amount: 0.025, unit: "second" },
    { label: "非(resolution = 480p) 且 非(resolution = 720p) 且 resolution = 768p · seconds", amount: 0.035, unit: "second" },
    { label: "非(resolution = 480p) 且 非(resolution = 720p) 且 非(resolution = 768p) · seconds", amount: 0.08, unit: "second" },
  ] };
  assert.equal(formatModelPricing(pricing), "分辨率 480p $0.025/秒\n分辨率 720p $0.025/秒\n分辨率 768p $0.035/秒\n其他 $0.08/秒");
});

test("formats per-second, per-request and token prices with explicit units", () => {
  assert.equal(formatModelPricing({ currency: "USD", mode: "per_second", rates: [{ label: "", amount: 0.8, unit: "second" }] }), "$0.8/秒");
  assert.equal(formatModelPricing({ currency: "USD", mode: "per_request", rates: [{ label: "", amount: 6, unit: "request" }] }), "$6/次");
  assert.equal(formatModelPricing({ currency: "USD", mode: "per_token", rates: [{ label: "输入", amount: 5, unit: "million_tokens" }, { label: "输出", amount: 30, unit: "million_tokens" }] }), "输入 $5/百万 tokens · 输出 $30/百万 tokens");
  assert.equal(formatModelPricing({ currency: "USD", mode: "per_second", rates: [{ label: "480p", amount: 0, unit: "second" }, { label: "720p", amount: 0.00000001, unit: "second" }] }), "480p $0/秒 · 720p $0.00000001/秒");
});

test("does not invent prices for missing, invalid or dynamic pricing", () => {
  assert.equal(formatModelPricing(), "未提供定价");
  assert.equal(formatModelPricing({ currency: "USD", mode: "per_request", rates: [] }), "未提供定价");
  for (const amount of [-1, NaN, Infinity]) assert.equal(formatModelPricing({ currency: "USD", mode: "per_request", rates: [{ amount, unit: "request" }] }), "未提供定价");
  assert.equal(formatModelPricing({ currency: "USD", mode: "dynamic", rates: [] }), "动态计费 · 按实际用量");
  assert.equal(formatModelPricing({ currency: "USD", mode: "dynamic", rates: [{ label: "resolution = 720p", amount: 0.2, unit: "request" }, { label: "非(resolution = 720p)", amount: 0.1, unit: "request" }] }), "分辨率 720p $0.2/次\n非(分辨率 720p) $0.1/次");
});

test("hides redundant billing labels while retaining their actual units", () => {
  assert.equal(formatModelPricing({ currency: "USD", mode: "per_second", rates: [{ label: "seconds", amount: 1.4, unit: "second" }] }), "$1.4/秒");
  assert.equal(formatModelPricing({ currency: "USD", mode: "dynamic", rates: [{ label: "count", amount: 0.8, unit: "count" }] }), "$0.8/个");
  assert.equal(formatModelPricing({ currency: "USD", mode: "per_request", rates: [{ label: "", amount: 0.8, unit: "request" }] }), "$0.8/次");
});

test("keeps each selected key's quote separate and retains unpriced models", () => {
  const pricing = { currency: "USD", mode: "per_second", rates: [{ label: "", amount: 0.8, unit: "second" }] };
  const result = modelPriceQuotesFromResponses([
    { tokenName: "云棉", displayName: "云棉", data: [{ id: " video ", pricing }, { id: "video", pricing }, { id: "unpriced" }] },
    { tokenName: "其他线路", displayName: "其他线路", data: [{ id: "video" }] },
  ]);
  assert.deepEqual(result.video, [{ tokenName: "云棉", displayName: "云棉", text: "$0.8/秒" }, { tokenName: "其他线路", displayName: "其他线路", text: "未提供定价" }]);
  assert.deepEqual(result.unpriced, [{ tokenName: "云棉", displayName: "云棉", text: "未提供定价" }]);
  assert.deepEqual(modelPriceQuotesFromResponses([{ tokenName: "刷新", displayName: "刷新", data: [{ id: "video" }] }]).video, [{ tokenName: "刷新", displayName: "刷新", text: "未提供定价" }]);
});

test("shows the selected Key label without exposing its internal identifier", () => {
 const quotes=modelPriceQuotesFromResponses([{tokenName:"__custom_relay__:private-id",displayName:"cs",data:[{id:"wan-3"}]}]);
 assert.equal(quotes["wan-3"][0].displayName,"cs");
});

test("distinguishes reference prices and pricing failures", () => {
  const pricing = { currency: "USD", reference: true, mode: "per_request", rates: [{ label: "", amount: 2, unit: "request" }] };
  assert.equal(formatModelPricing(pricing), "$2/次");
  const quotes = modelPriceQuotesFromResponses([{ tokenName: "a", displayName: "a", pricing_error: "价格获取失败", data: [{ id: "model" }] }]);
  assert.equal(quotes.model[0].text, "价格获取失败");
});

test("omits generic tier labels while keeping meaningful rate labels", () => {
  assert.equal(formatModelPricing({ currency: "USD", mode: "dynamic", rates: [{ label: "base", amount: 0.06, unit: "request" }] }), "$0.06/次");
  assert.equal(formatModelPricing({ currency: "USD", mode: "dynamic", rates: [{ label: "standard", amount: 0.06, unit: "request" }] }), "$0.06/次");
  assert.equal(formatModelPricing({ currency: "USD", mode: "dynamic", rates: [{ label: "base · 输入", amount: 1, unit: "million_tokens" }, { label: "base · 输出", amount: 2, unit: "million_tokens" }] }), "输入 $1/百万 tokens\n输出 $2/百万 tokens");
});
