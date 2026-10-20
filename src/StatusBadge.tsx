import { useEffect, useState } from "react";
import type { ConnectionStatus } from "./sync";

export function StatusBadge({ status, pending }: { status: ConnectionStatus; pending: number }) {
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);

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
      label = `已连接 · ${status.peers} 人在线${status.latencyMs !== null ? ` · 延迟 ${status.latencyMs} ms` : ""}`;
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
  }

  return (
    <div className="topbar">
      <span className={`status status-${tone}`} title="与服务器的实时连接状态">
        <span className="dot" />
        {label}
        {pending > 0 && status.kind !== "not_found" && <span className="pending">，{pending} 处修改待同步</span>}
      </span>
      <button className="share" onClick={copyLink}>
        {copied ? "已复制" : "复制分享链接"}
      </button>
    </div>
  );
}
