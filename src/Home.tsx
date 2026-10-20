import { useState } from "react";

export function Home() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/boards", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { id } = (await res.json()) as { id: string };
      location.assign(`/b/${id}`);
    } catch (err) {
      setError(`创建失败：${(err as Error).message}，请稍后再试`);
      setCreating(false);
    }
  };

  return (
    <main className="home">
      <h1>共享白板</h1>
      <p>新建一块白板，把链接发给别人，就可以一起实时编辑。</p>
      <button className="button" onClick={create} disabled={creating}>
        {creating ? "正在创建…" : "新建白板"}
      </button>
      {error && <p className="error">{error}</p>}
    </main>
  );
}
