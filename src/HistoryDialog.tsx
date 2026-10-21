import { useEffect, useState } from "react";
import { listSnapshots, type SnapshotSummary } from "./api";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// 自动备份列表：选一个版本恢复
export function HistoryDialog({
  boardId,
  onRestore,
  onClose,
}: {
  boardId: string;
  onRestore(snapshot: SnapshotSummary): void;
  onClose(): void;
}) {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SnapshotSummary | null>(null);

  useEffect(() => {
    listSnapshots(boardId)
      .then(setSnapshots)
      .catch((err) => setError(`加载失败：${(err as Error).message}`));
  }, [boardId]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog card history" onClick={(e) => e.stopPropagation()}>
        <h2>历史版本</h2>
        <p className="muted">有人编辑时每 2 分钟自动备份一次，保留最近 20 份。恢复后可以按 Ctrl+Z（Mac 上是 ⌘+Z）撤销。</p>
        {error && <p className="error">{error}</p>}
        {snapshots === null && !error && <p className="muted">正在加载…</p>}
        {snapshots?.length === 0 && <p className="muted">还没有备份。开始编辑 2 分钟后会生成第一份。</p>}
        {snapshots && snapshots.length > 0 && (
          <ul className="snapshots">
            {snapshots.map((s) => (
              <li key={s.id}>
                <label>
                  <input type="radio" name="snapshot" checked={selected?.id === s.id} onChange={() => setSelected(s)} />
                  <span>
                    <strong>{formatTime(s.createdAt)}</strong>
                    <span className="muted">
                      {" "}
                      · {s.elementCount} 个图形{s.editors.length > 0 && ` · ${s.editors.join("、")} 编辑`}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button className="button secondary" onClick={onClose}>
            取消
          </button>
          <button className="button" disabled={!selected} onClick={() => selected && onRestore(selected)}>
            恢复到这个版本
          </button>
        </div>
      </div>
    </div>
  );
}
