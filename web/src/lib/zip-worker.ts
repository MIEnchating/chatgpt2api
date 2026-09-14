import { unzipSync, zipSync } from "fflate";
import { MAX_ZIP_BYTES, MAX_ZIP_ENTRIES, type ZipWorkerRequest } from "./zip-worker-contract";

globalThis.onmessage = (event: MessageEvent<ZipWorkerRequest>) => {
  try {
    const request = event.data;
    if (request.operation === "create") {
      const result = zipSync(Object.fromEntries(request.entries), { level: 0 });
      if (result.byteLength > MAX_ZIP_BYTES) throw new Error("项目压缩包大小不能超过 1 GiB");
      globalThis.postMessage({ result }, { transfer: [result.buffer] });
      return;
    }

    let total = 0;
    const names = new Set<string>();
    // Inspect the directory before allocating any decompressed media buffers.
    unzipSync(request.data, { filter: (file) => {
      if (names.has(file.name)) throw new Error("项目压缩包包含重复文件名");
      if (file.compression === 0 && file.size !== file.originalSize) throw new Error("项目压缩包媒体大小不符");
      names.add(file.name);
      total += file.originalSize;
      if (names.size > MAX_ZIP_ENTRIES) throw new Error("项目压缩包文件数量超过限制");
      if (!Number.isSafeInteger(total) || total > MAX_ZIP_BYTES) throw new Error("项目解压后大小不能超过 1 GiB");
      return false;
    } });
    const result = Object.entries(unzipSync(request.data));
    if (result.reduce((bytes, [, data]) => bytes + data.byteLength, 0) !== total) throw new Error("项目压缩包媒体大小不符");
    globalThis.postMessage({ result }, { transfer: result.map(([, data]) => data.buffer) });
  } catch (error) {
    globalThis.postMessage({ error: error instanceof Error ? error.message : "项目压缩包处理失败" });
  }
};
