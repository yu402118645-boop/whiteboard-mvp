import { useEffect, useState } from "react";
import { createBoard, deleteBoard, listBoards, renameBoard, type BoardSummary } from "./api";
import { NameDialog } from "./NameDialog";

type Dialog = { kind: "create" } | { kind: "rename"; board: BoardSummary } | { kind: "delete"; board: BoardSummary } | null;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function Home() {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    listBoards()
      .then(setBoards)
      .catch((err) => setError(`加载白板列表失败：${(err as Error).message}`));

  useEffect(() => {
    document.title = "共享白板";
    refresh();
  }, []);

  const run = async (action: () => Promise<unknown>, failure: string) => {
    setDialog(null);
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(`${failure}：${(err as Error).message}，请稍后再试`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="home">
      <h1>共享白板</h1>
      <p>新建一块白板，把链接发给别人，就可以一起实时编辑。</p>
      <button className="button" onClick={() => setDialog({ kind: "create" })} disabled={busy}>
        新建白板
      </button>
      {error && <p className="error">{error}</p>}

      {boards === null && !error && <p className="muted">正在加载…</p>}
      {boards?.length === 0 && <p className="muted">还没有白板。</p>}
      {boards && boards.length > 0 && (
        <ul className="list">
          {boards.map((board) => (
            <li key={board.id}>
              <a href={`/b/${board.id}`}>
                <span className="title">{board.name}</span>
                <span className="time">
                  {board.lastOpenedAt ? `最近打开 ${formatTime(board.lastOpenedAt)}` : `创建于 ${formatTime(board.createdAt)}`}
                </span>
              </a>
              <button className="link-button" onClick={() => setDialog({ kind: "rename", board })} disabled={busy}>
                重命名
              </button>
              <button className="link-button danger" onClick={() => setDialog({ kind: "delete", board })} disabled={busy}>
                删除
              </button>
            </li>
          ))}
        </ul>
      )}

      {dialog?.kind === "create" && (
        <NameDialog
          title="新建白板"
          initial=""
          confirmText="创建"
          onConfirm={(name) =>
            run(async () => {
              const { id } = await createBoard(name);
              location.assign(`/b/${id}`);
            }, "创建失败")
          }
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title="重命名白板"
          initial={dialog.board.name}
          onConfirm={(name) => run(() => renameBoard(dialog.board.id, name).then(refresh), "重命名失败")}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete" && (
        <div className="overlay" onClick={() => setDialog(null)}>
          <div className="dialog card" onClick={(e) => e.stopPropagation()}>
            <h2>删除「{dialog.board.name}」？</h2>
            <p className="muted">白板里的所有内容和图片都会被永久删除，正在使用的人会被断开。这个操作无法撤销。</p>
            <div className="actions">
              <button className="button secondary" onClick={() => setDialog(null)}>
                取消
              </button>
              <button
                className="button danger"
                onClick={() => run(() => deleteBoard(dialog.board.id).then(refresh), "删除失败")}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
