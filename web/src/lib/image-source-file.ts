export type ImageBlobLoader = (source: string) => Promise<Blob>;

export async function imageSourceToFile(
  sourceValue: string,
  fileName: string,
  mimeType: string | undefined,
  loadImageBlob: ImageBlobLoader,
) {
  const source = sourceValue.trim();
  if (!source.startsWith("data:")) {
    const blob = await loadImageBlob(source);
    return new File([blob], fileName, { type: blob.type || mimeType || "image/png" });
  }

  const [header, content] = source.split(",", 2);
  if (!content) {
    throw new Error("参考图数据无效");
  }
  const matchedMimeType = header.match(/data:(.*?);base64/)?.[1];
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], fileName, { type: mimeType || matchedMimeType || "image/png" });
}
