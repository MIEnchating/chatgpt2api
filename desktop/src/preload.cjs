"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktopConnection", Object.freeze({
  settings: () => ipcRenderer.invoke("desktop:settings"),
  connect: (value) => ipcRenderer.invoke("desktop:connect", value),
}));
