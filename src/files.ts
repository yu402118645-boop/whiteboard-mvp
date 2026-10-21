// 图片上传下载。图片存在白板自己的 SQLite 里，单个值不能超过 2 MB，所以大图先压缩

import type { BinaryFileData } from "@excalidraw/excalidraw/types";

const MAX_UPLOAD_BYTES = 1_800_000;
const MAX_DIMENSION = 2000;

async function dataURLToBlob(dataURL: string): Promise<Blob> {
  return (await fetch(dataURL)).blob();
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function compress(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  let scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  for (let quality = 0.85; ; quality -= 0.15) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    if (out && out.size <= MAX_UPLOAD_BYTES) return out;
    if (quality < 0.5) {
      scale *= 0.7;
      quality = 1;
    }
  }
}

export async function uploadFile(boardId: string, file: BinaryFileData): Promise<void> {
  let blob = await dataURLToBlob(file.dataURL);
  if (blob.size > MAX_UPLOAD_BYTES) blob = await compress(blob);
  const res = await fetch(`/api/boards/${boardId}/files/${file.id}`, {
    method: "PUT",
    headers: { "content-type": blob.type || file.mimeType },
    body: blob,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function downloadFile(
  boardId: string,
  fileId: string,
  retries: number,
  retryMs: number,
): Promise<BinaryFileData | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`/api/boards/${boardId}/files/${fileId}`);
      if (res.ok) {
        const blob = await res.blob();
        return {
          id: fileId,
          mimeType: blob.type,
          dataURL: await blobToDataURL(blob),
          created: Date.now(),
        } as BinaryFileData;
      }
    } catch {
      // 网络错误，稍后重试
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  return null;
}
