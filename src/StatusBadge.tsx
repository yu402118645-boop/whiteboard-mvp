import { useEffect, useState } from "react";
import type { ConnectionStatus } from "./sync";

export function StatusBadge({
  status,
  pending,
  boardName,
  nickname,
  onRename,
  onEditNickname,
  onEditSolid,
  onInsertSolid,
}: {
  status: ConnectionStatus;
  pending: number;
  boardName: string;
  nickname: string;
  onRename(): void;
  onEditNickname(): void;
  // 选中 3D 体时才有
  onEditSolid?: () => void;
  onInsertSolid(): void;
}) {
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  // 手机竖屏时收起来的「⋯」菜单是否展开
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (status.kind !== "offline") return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [status.kind]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
    } catch {
      window.prompt("复制这个链接发给协作者：", location.href);
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  let tone: "ok" | "warn" | "bad";
  let label: string;
  switch (status.kind) {
    case "connected":
      tone = "ok";
      label = `${status.peers} 人在线${status.latencyMs !== null ? ` · ${status.latencyMs} ms` : ""}`;
      break;
    case "connecting":
      tone = "warn";
      label = status.attempt === 0 ? "正在连接…" : `正在重连（第 ${status.attempt} 次）…`;
      break;
    case "offline": {
      tone = "bad";
      const seconds = Math.max(0, Math.ceil((status.retryAt - now) / 1000));
      label = `连接已断开，${seconds} 秒后重连`;
      break;
    }
    case "not_found":
      tone = "bad";
      label = "白板不存在";
      break;
    case "deleted":
      tone = "bad";
      label = "白板已在回收站";
      break;
  }

  const showPending = pending > 0 && status.kind !== "not_found" && status.kind !== "deleted";
  // 菜单里的按钮点完顺手把菜单关掉
  const fromMenu = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

  return (
    <>
    <div className="topbar">
      {/* Excalidraw 的顶部工具栏不支持加自定义按钮，所以放在右上角这一排的最前面 */}
      {onEditSolid ? (
        <button className="chip solid-edit" onClick={onEditSolid}>
          修改 3D 尺寸
        </button>
      ) : (
        <button className="chip solid-edit" onClick={onInsertSolid} title="插入立方体、圆柱、圆锥、球">
          ＋ 3D 体
        </button>
      )}
      {boardName && (
        <button className="chip board-name" onClick={onRename} title="点击重命名白板">
          {boardName}
        </button>
      )}
      <span className={`status status-${tone}`} title={`与服务器的连接状态：${label}`}>
        <span className="dot" />
        <span className="status-label">{label}</span>
        {/* 平板横屏放不下完整文字时只显示在线人数 */}
        <span className="status-short">{status.kind === "connected" ? `${status.peers} 人` : label}</span>
        {showPending && <span className="pending">，{pending} 处修改待同步</span>}
      </span>
      {nickname && (
        <button className="chip" onClick={onEditNickname} title="点击修改昵称">
          <span className="me-prefix">我：</span>
          {nickname}
        </button>
      )}
      <button className="chip" onClick={copyLink} title="复制这块白板的链接">
        {copied ? "已复制" : "分享"}
      </button>
    </div>
    {/* 手机竖屏：只留一个连接状态圆点和「⋯」菜单，免得把 Excalidraw 的工具栏挤出屏幕 */}
    <div className="topbar-compact">
      <span className={`status status-${tone} status-dot-only`} title={label}>
        <span className="dot" />
        {status.kind === "connected" && status.peers}
        {showPending && <span className="pending">!</span>}
      </span>
      <button className="chip more-button" onClick={() => setMenuOpen((open) => !open)} aria-label="更多">
        ⋯
      </button>
      {menuOpen && (
        <>
          <div className="compact-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="compact-menu">
            <div className={`compact-menu-status status-${tone}`}>
              <span className="dot" />
              <span>
                {label}
                {showPending && <span className="pending">，{pending} 处修改待同步</span>}
              </span>
            </div>
            {onEditSolid ? (
              <button onClick={fromMenu(onEditSolid)}>修改 3D 尺寸</button>
            ) : (
              <button onClick={fromMenu(onInsertSolid)}>＋ 插入 3D 体</button>
            )}
            {boardName && <button onClick={fromMenu(onRename)}>重命名白板「{boardName}」</button>}
            {nickname && <button onClick={fromMenu(onEditNickname)}>修改昵称（{nickname}）</button>}
            <button onClick={fromMenu(copyLink)}>复制分享链接</button>
          </div>
        </>
      )}
      {copied && <span className="compact-toast">链接已复制</span>}
    </div>
    </>
  );
}
