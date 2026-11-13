import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider, useTranslator } from "@videojs/react/i18n";
import zhCN from "@videojs/react/i18n/locales/zh-CN";
import { enterText, exitText } from "@videojs/react/i18n/text/fullscreen";
import { settingsText, playbackRateText, captionsText } from "@videojs/react/i18n/text/menu";
import { playText, pauseText } from "@videojs/react/i18n/text/buttons";

const source = readFileSync(new URL("../src/components/media-video-player.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, {
  exports,
  require(name) {
    if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }) };
    if (name === "@videojs/react/i18n") return { I18nProvider: "I18nProvider" };
    if (name === "@videojs/react/i18n/locales/zh-CN") return { default: zhCN };
    if (name === "@videojs/react/video") return { Video: "Video", VideoPlayer: "VideoPlayer", VideoSkin: "VideoSkin" };
    if (name === "@videojs/react/video/skin.css") return {};
    if (name === "@/lib/utils") return { cn: (...classes) => classes.filter(Boolean).join(" ") };
    throw new Error(`Unexpected import: ${name}`);
  },
});

test("player controls use Simplified Chinese on the first render", () => {
  const provider = exports.MediaVideoPlayer({ src: "/video.mp4" }).props.children;
  function ControlLabels() {
    const translate = useTranslator();
    return createElement("span", null, [enterText, exitText, settingsText, playbackRateText, captionsText, playText, pauseText].map(text => translate(text)).join(" · "));
  }
  const html = renderToStaticMarkup(createElement(I18nProvider, provider.props, createElement(ControlLabels)));
  assert.equal(html, "<span>全屏 · 退出全屏 · 设置 · 播放速度 · 字幕 · 播放 · 暂停</span>");
});

test("player forwards the source and maintains the supplied frame and label", () => {
  const wrapper = exports.MediaVideoPlayer({ src: "/video.mp4", aspectRatio: "9 / 16", title: "生成视频" });
  assert.equal(wrapper.props.style.aspectRatio, "9 / 16");
  assert.equal(wrapper.props["aria-label"], "生成视频");
  const provider = wrapper.props.children;
  assert.equal(provider.props.locale, "zh-CN");
  const video = provider.props.children.props.children.props.children;
  assert.equal(video.type, "Video");
  assert.equal(video.props.src, "/video.mp4");
  assert.equal(video.props.playsInline, true);
});
