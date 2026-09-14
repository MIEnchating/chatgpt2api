type ZipFile = {
  name: string;
  data: BlobPart;
};

type ZipWorkerResult = Uint8Array<ArrayBuffer> | [string, Uint8Array<ArrayBuffer>][];

function runZipWorker<T extends ZipWorkerResult>(request: ZipWorkerRequest, transfer: ArrayBuffer[]) {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(new URL("./zip-worker.ts", import.meta.url), { type: "module" });
    const finish = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<{ result?: T; error?: string }>) => {
      finish();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.result) resolve(event.data.result);
      else reject(new Error("项目压缩包处理失败"));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish();
      reject(new Error(event.message || "项目压缩包处理失败"));
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error("项目压缩包读取失败"));
    };
    try {
      worker.postMessage(request, transfer);
    } catch (error) {
      finish();
      reject(error);
    }
  });
}

export async function createZip(files: ZipFile[]) {
  if (files.length > MAX_ZIP_ENTRIES) throw new Error("项目压缩包文件数量超过限制");
  const names = new Set<string>();
  let total = 0;
  const blobs = files.map((file) => {
    if (names.has(file.name)) throw new Error("项目压缩包包含重复文件名");
    names.add(file.name);
    const blob = new Blob([file.data]);
    total += blob.size;
    if (total > MAX_ZIP_BYTES) throw new Error("项目压缩包大小不能超过 1 GiB");
    return { name: file.name, blob };
  });
  const entries = await Promise.all(blobs.map(async ({ name, blob }): Promise<[string, Uint8Array<ArrayBuffer>]> => {
    return [name, new Uint8Array(await blob.arrayBuffer())];
  }));
  const data = await runZipWorker<Uint8Array<ArrayBuffer>>({ operation: "create", entries }, entries.map(([, data]) => data.buffer));
  return new Blob([data], { type: "application/zip" });
}

export async function readZip(file: Blob) {
  if (file.size > MAX_ZIP_BYTES) throw new Error("项目压缩包大小不能超过 1 GiB");
  const data = new Uint8Array(await file.arrayBuffer());
  const entries = await runZipWorker<[string, Uint8Array<ArrayBuffer>][]>({ operation: "read", data }, [data.buffer]);
  return new Map(entries.map(([name, data]) => [name, new Blob([data])]));
}
import { MAX_ZIP_BYTES, MAX_ZIP_ENTRIES, type ZipWorkerRequest } from "./zip-worker-contract";

export { MAX_ZIP_BYTES, MAX_ZIP_ENTRIES } from "./zip-worker-contract";
