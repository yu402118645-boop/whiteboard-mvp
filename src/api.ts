export type BoardSummary = {
  id: string;
  name: string;
  createdAt: string;
  lastOpenedAt: string | null;
  deletedAt: string | null;
};

export type SnapshotSummary = { id: number; createdAt: string; elementCount: number; editors: string[] };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const listBoards = () => request<{ boards: BoardSummary[]; trash: BoardSummary[] }>("/api/boards");

export const createBoard = (name: string) =>
  request<{ id: string; name: string }>("/api/boards", { method: "POST", body: JSON.stringify({ name }) });

export const renameBoard = (id: string, name: string) =>
  request<{ id: string; name: string }>(`/api/boards/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });

/** 默认移到回收站；permanent 为 true 时彻底删除 */
export const deleteBoard = (id: string, permanent = false) =>
  request<{ ok: true }>(`/api/boards/${id}${permanent ? "?permanent=1" : ""}`, { method: "DELETE" });

export const restoreBoard = (id: string) => request<{ ok: true }>(`/api/boards/${id}/restore`, { method: "POST" });

export const listSnapshots = (id: string) => request<SnapshotSummary[]>(`/api/boards/${id}/snapshots`);

export const getSnapshot = <T>(id: string, snapshotId: number) =>
  request<T[]>(`/api/boards/${id}/snapshots/${snapshotId}`);
