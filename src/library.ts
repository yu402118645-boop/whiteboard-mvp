// 共享素材库：所有人共用服务器上的同一份。刷新页面后能看到别人新加的素材

import type { LibraryPersistenceAdapter } from "@excalidraw/excalidraw/data/library";

export const libraryAdapter: LibraryPersistenceAdapter = {
  async load() {
    const res = await fetch("/api/library");
    if (!res.ok) throw new Error(`加载素材库失败：HTTP ${res.status}`);
    return res.json();
  },
  async save(data) {
    const res = await fetch("/api/library", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `保存素材库失败：HTTP ${res.status}`);
    }
  },
};
