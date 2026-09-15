"use strict";
const form = document.querySelector("#connection-form");
const remoteURL = document.querySelector("#remote-url");
const password = document.querySelector("#admin-password");
const status = document.querySelector("#status");
const submit = document.querySelector("#connect");
let settings = null;
let busy = false;
function refreshFields() {
  const local = form.elements.mode.value === "local";
  document.querySelector("#remote-fields").hidden = local;
  document.querySelector("#password-fields").hidden = !local || !settings?.needsPassword;
  document.querySelector("#local-details").hidden = !local;
  remoteURL.required = !local;
  password.required = local && settings?.needsPassword === true;
  remoteURL.disabled = busy || local;
  password.disabled = busy || !password.required;
}
form.addEventListener("change", refreshFields);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !settings) return;
  busy = true;
  const input = { mode: form.elements.mode.value, remoteURL: remoteURL.value, adminPassword: password.value };
  password.value = "";
  for (const element of form.elements) element.disabled = true;
  status.classList.add("busy");
  status.textContent = input.mode === "local" && !settings.development ? "正在启动本地空间，首次启动可能需要一些时间…" : "正在连接服务器…";
  submit.firstChild.textContent = "正在连接 ";
  try {
    const result = await window.desktopConnection.connect(input);
    input.adminPassword = "";
    if (!result.ok) throw new Error(result.error);
  } catch (error) { status.textContent = error.message || "连接失败，请重试"; }
  finally {
    input.adminPassword = "";
    busy = false;
    for (const element of form.elements) element.disabled = false;
    refreshFields();
    status.classList.remove("busy");
    submit.firstChild.textContent = "重试连接 ";
  }
});
(async () => {
  try {
    settings = await window.desktopConnection.settings();
    form.elements.mode.value = settings.mode;
    remoteURL.value = settings.remoteURL;
    document.querySelector("#data-directory").textContent = settings.dataDirectory;
    status.textContent = settings.statusMessage;
    if (settings.development) document.querySelector("#local-description").textContent = "复用现有 Vite 8002 和 Go 8090 源码服务。";
    refreshFields();
  } catch (error) { status.textContent = error.message || "无法读取连接设置"; submit.disabled = true; }
})();
