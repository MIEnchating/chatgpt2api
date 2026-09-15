"use strict";

const flushScript = `(() => {
  const pending = [];
  window.dispatchEvent(new CustomEvent("chatgpt2api:flush-before-leave", { detail: pending }));
  return Promise.all(pending).then(() => undefined);
})()`;

async function flushChanges(windows, timeoutMs = 10000) {
  const pending = windows.filter((window) => !window.isDestroyed()).map((window) => window.webContents.executeJavaScript(flushScript));
  if (!pending.length) return;
  let timer;
  try {
    await Promise.race([
      Promise.all(pending),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("保存画布超时，请确认网络正常后重试")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

module.exports = { flushChanges };
