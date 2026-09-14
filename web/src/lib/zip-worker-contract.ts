export const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 25_000;

export type ZipWorkerRequest =
  | { operation: "create"; entries: [string, Uint8Array<ArrayBuffer>][] }
  | { operation: "read"; data: Uint8Array<ArrayBuffer> };
