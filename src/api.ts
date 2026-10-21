export type BoardSummary = { id: string; name: string; createdAt: string; lastOpenedAt: string | null };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const listBoards = () => request<BoardSummary[]>("/api/boards");

export const createBoard = (name: string) =>
  request<{ id: string; name: string }>("/api/boards", { method: "POST", body: JSON.stringify({ name }) });

export const renameBoard = (id: string, name: string) =>
  request<{ id: string; name: string }>(`/api/boards/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });

export const deleteBoard = (id: string) => request<{ ok: true }>(`/api/boards/${id}`, { method: "DELETE" });
