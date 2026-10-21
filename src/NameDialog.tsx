import { useState } from "react";

// 通用的单行输入对话框：设置昵称、给白板命名
export function NameDialog({
  title,
  hint,
  initial,
  confirmText = "确定",
  onConfirm,
  onCancel,
}: {
  title: string;
  hint?: string;
  initial: string;
  confirmText?: string;
  onConfirm(value: string): void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();

  return (
    <div className="overlay" onClick={onCancel}>
      <form
        className="dialog card"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) onConfirm(trimmed);
        }}
      >
        <h2>{title}</h2>
        {hint && <p className="muted">{hint}</p>}
        <input autoFocus maxLength={40} value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="actions">
          {onCancel && (
            <button type="button" className="button secondary" onClick={onCancel}>
              取消
            </button>
          )}
          <button type="submit" className="button" disabled={!trimmed}>
            {confirmText}
          </button>
        </div>
      </form>
    </div>
  );
}
