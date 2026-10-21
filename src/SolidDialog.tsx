import { useRef, useState } from "react";
import {
  CUT_MAX,
  CUTTABLE,
  DEFAULT_SIZE,
  SIZE_LABELS,
  SIZE_MAX,
  SIZE_MIN,
  SOLID_LABELS,
  sizeHandles,
  solidName,
  solidParts,
  type SolidSize,
  type SolidSpec,
  type SolidType,
} from "./solids";

const PREVIEW_W = 300;
const PREVIEW_H = 240;
const PAD = 24;
const TYPES: SolidType[] = ["cube", "cylinder", "cone", "pyramid", "sphere"];
type Dim = keyof SolidSize;

// 截掉高度可以是 0（尖顶），其余尺寸至少 SIZE_MIN
const range = (dim: Dim): [number, number] => (dim === "cut" ? [0, CUT_MAX] : [SIZE_MIN, SIZE_MAX]);
const clamp = (dim: Dim, v: number) => {
  const [min, max] = range(dim);
  return Math.round(Math.min(max, Math.max(min, v)));
};

function bounds(spec: SolidSpec) {
  let maxX = 0;
  let maxY = 0;
  for (const part of solidParts(spec)) {
    if (part.kind === "ellipse") {
      maxX = Math.max(maxX, part.x + part.width);
      maxY = Math.max(maxY, part.y + part.height);
    } else {
      for (const [x, y] of part.points) {
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { maxX, maxY };
}

// 插入或修改 3D 体：选类型，拖滑块或拖预览图上的圆点调整尺寸
export function SolidDialog({
  initial,
  editing,
  onConfirm,
  onCancel,
}: {
  initial: SolidSpec;
  editing: boolean;
  onConfirm(spec: SolidSpec): void;
  onCancel(): void;
}) {
  const [spec, setSpec] = useState<SolidSpec>(initial);
  const drag = useRef<{ dim: Dim; startX: number; startY: number; start: number; scale: number } | null>(null);

  // 预览自动缩放到框内；拖动时按开始拖动那一刻的比例换算，数值变化才稳定
  const { maxX, maxY } = bounds(spec);
  const s = Math.min(1.2, (PREVIEW_W - PAD * 2) / maxX, (PREVIEW_H - PAD * 2) / maxY);
  const ox = (PREVIEW_W - maxX * s) / 2;
  const oy = (PREVIEW_H - maxY * s) / 2;
  const P = (x: number, y: number) => [ox + x * s, oy + y * s] as const;

  // 输入框里正在编辑的文字：允许暂时不合法（比如想输 50 时先敲出的 5），合法时才更新预览
  const [drafts, setDrafts] = useState<Partial<Record<Dim, string>>>({});
  const parseSize = (dim: Dim, text: string) => {
    const value = Number(text);
    const [min, max] = range(dim);
    return /^\d+$/.test(text.trim()) && value >= min && value <= max ? value : null;
  };
  const invalid = (Object.keys(drafts) as Dim[]).filter((dim) => parseSize(dim, drafts[dim]!) === null);

  const setDim = (dim: Dim, value: number) => {
    setSpec((prev) => ({ ...prev, [dim]: clamp(dim, value) }));
    setDrafts(({ [dim]: _, ...rest }) => rest);
  };

  const typeDim = (dim: Dim, text: string) => {
    setDrafts((prev) => ({ ...prev, [dim]: text }));
    const value = parseSize(dim, text);
    if (value !== null) setSpec((prev) => ({ ...prev, [dim]: value }));
  };

  const finishTyping = (dim: Dim) => {
    if (drafts[dim] !== undefined && parseSize(dim, drafts[dim]!) !== null) {
      setDrafts(({ [dim]: _, ...rest }) => rest);
    }
  };

  const submit = () => {
    if (invalid.length === 0) onConfirm(spec);
  };

  // 三个手柄：右边拖长/直径，上边拖高，进深手柄（方形的在右上角斜着拖，圆形的在底部上下拖）
  const handles = sizeHandles(spec).map((handle) => ({ ...handle, at: P(...handle.at) }));

  const onPointerDown = (dim: Dim) => (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { dim, startX: e.clientX, startY: e.clientY, start: spec[dim] ?? 0, scale: s };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const current = drag.current;
    if (!current) return;
    const handle = handles.find((x) => x.dim === current.dim)!;
    // 预览 SVG 可能被缩放显示，换算成 SVG 坐标
    const svg = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = PREVIEW_W / svg.width;
    const moved = ((e.clientX - current.startX) * handle.axis[0] + (e.clientY - current.startY) * handle.axis[1]) * px;
    setDim(current.dim, current.start + (moved * handle.factor) / current.scale);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const labels = [...SIZE_LABELS[spec.type], "顶部截掉的高度"];
  const dims: Dim[] = CUTTABLE.includes(spec.type) ? ["w", "h", "d", "cut"] : ["w", "h", "d"];

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog card solid-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{editing ? `修改${solidName(spec)}尺寸` : "插入 3D 体"}</h2>
        {!editing && (
          <div className="segmented">
            {TYPES.map((type) => (
              <button
                key={type}
                className={type === spec.type ? "active" : ""}
                onClick={() => {
                  setSpec({ type, ...DEFAULT_SIZE[type] });
                  setDrafts({});
                }}
              >
                {SOLID_LABELS[type]}
              </button>
            ))}
          </div>
        )}
        {spec.type === "pyramid" && (
          <div className="segmented sub">
            {([3, 4] as const).map((sides) => (
              <button
                key={sides}
                className={(spec.sides ?? 4) === sides ? "active" : ""}
                onClick={() => setSpec((prev) => ({ ...prev, sides }))}
              >
                {sides === 3 ? "三棱" : "四棱"}
              </button>
            ))}
          </div>
        )}
        <svg
          className="solid-preview"
          viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {solidParts(spec).map((part, i) =>
            part.kind === "ellipse" ? (
              <ellipse
                key={i}
                cx={P(part.x + part.width / 2, 0)[0]}
                cy={P(0, part.y + part.height / 2)[1]}
                rx={(part.width / 2) * s}
                ry={(part.height / 2) * s}
                className="solid-face"
              />
            ) : (
              <polyline
                key={i}
                points={[...part.points, ...(part.closed ? [part.points[0]] : [])]
                  .map(([x, y]) => P(x, y).join(","))
                  .join(" ")}
                className={part.role === "face" ? "solid-face" : part.dashed ? "solid-hidden" : "solid-edge"}
              />
            ),
          )}
          {handles.map((h) => (
            <circle
              key={h.dim}
              cx={h.at[0]}
              cy={h.at[1]}
              r={8}
              className={`solid-handle handle-${h.dim}`}
              onPointerDown={onPointerDown(h.dim)}
            >
              <title>{`拖动调整${labels[dims.indexOf(h.dim)]}`}</title>
            </circle>
          ))}
        </svg>
        <p className="muted solid-tip">
          拖动预览图上的圆点，或者拖下面的滑块。
          {CUTTABLE.includes(spec.type) && "「顶部截掉的高度」大于 0 时变成台体。"}
        </p>
        {dims.map((dim, i) => (
          <div key={dim}>
            <label className="solid-slider">
              <span>{labels[i]}</span>
              <input
                type="range"
                min={range(dim)[0]}
                max={range(dim)[1]}
                value={spec[dim] ?? 0}
                onChange={(e) => setDim(dim, Number(e.target.value))}
              />
              <input
                type="text"
                inputMode="numeric"
                className={invalid.includes(dim) ? "invalid" : ""}
                value={drafts[dim] ?? String(spec[dim] ?? 0)}
                onChange={(e) => typeDim(dim, e.target.value)}
                onBlur={() => finishTyping(dim)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </label>
            {invalid.includes(dim) && (
              <p className="field-error">
                请输入 {range(dim)[0]}～{range(dim)[1]} 之间的整数
              </p>
            )}
          </div>
        ))}
        <div className="actions">
          <button className="button secondary" onClick={onCancel}>
            取消
          </button>
          <button className="button" onClick={submit} disabled={invalid.length > 0}>
            {editing ? "确定" : "插入"}
          </button>
        </div>
      </div>
    </div>
  );
}
