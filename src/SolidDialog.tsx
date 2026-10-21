import { useRef, useState } from "react";
import {
  DEFAULT_SIZE,
  SIZE_LABELS,
  SIZE_MAX,
  SIZE_MIN,
  SOLID_LABELS,
  solidParts,
  type SolidSize,
  type SolidSpec,
  type SolidType,
} from "./solids";

const PREVIEW_W = 300;
const PREVIEW_H = 240;
const PAD = 24;
const TYPES: SolidType[] = ["cube", "cylinder", "cone", "sphere"];
type Dim = keyof SolidSize;

const clamp = (v: number) => Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, v)));

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

  const setDim = (dim: Dim, value: number) => setSpec((prev) => ({ ...prev, [dim]: clamp(value) }));

  // 三个手柄：右边拖长/直径，上边拖高，进深手柄（立方体在右上角斜着拖，圆形在底部上下拖）
  // axis 是屏幕上的拖动方向，factor 是拖动 1 像素对应尺寸变化多少（未除以缩放）
  const { w, h, d, type } = spec;
  const o = d * (Math.SQRT1_2 / 2);
  const ry = d * 0.25;
  const handles: { dim: Dim; at: readonly [number, number]; axis: [number, number]; factor: number }[] =
    type === "cube"
      ? [
          { dim: "w", at: P(w, o + h / 2), axis: [1, 0], factor: 1 },
          { dim: "h", at: P(w / 2, o), axis: [0, -1], factor: 1 },
          { dim: "d", at: P(w + o, 0), axis: [Math.SQRT1_2, -Math.SQRT1_2], factor: 2 },
        ]
      : [
          { dim: "w", at: P(w, type === "cylinder" ? ry + h / 2 : type === "cone" ? h : h / 2), axis: [1, 0], factor: 1 },
          { dim: "h", at: P(w / 2, 0), axis: [0, -1], factor: 1 },
          {
            dim: "d",
            at: P(w / 2, type === "cylinder" ? h + 2 * ry : type === "cone" ? h + ry : h / 2 + ry),
            axis: [0, 1],
            factor: 4,
          },
        ];

  const onPointerDown = (dim: Dim) => (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { dim, startX: e.clientX, startY: e.clientY, start: spec[dim], scale: s };
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

  const labels = SIZE_LABELS[spec.type];
  const dims: Dim[] = ["w", "h", "d"];

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog card solid-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{editing ? `修改${SOLID_LABELS[spec.type]}尺寸` : "插入 3D 体"}</h2>
        {!editing && (
          <div className="segmented">
            {TYPES.map((type) => (
              <button
                key={type}
                className={type === spec.type ? "active" : ""}
                onClick={() => setSpec({ type, ...DEFAULT_SIZE[type] })}
              >
                {SOLID_LABELS[type]}
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
        <p className="muted solid-tip">拖动预览图上的圆点，或者拖下面的滑块。</p>
        {dims.map((dim, i) => (
          <label key={dim} className="solid-slider">
            <span>{labels[i]}</span>
            <input
              type="range"
              min={SIZE_MIN}
              max={SIZE_MAX}
              value={spec[dim]}
              onChange={(e) => setDim(dim, Number(e.target.value))}
            />
            <input
              type="number"
              min={SIZE_MIN}
              max={SIZE_MAX}
              value={spec[dim]}
              onChange={(e) => setDim(dim, Number(e.target.value))}
            />
          </label>
        ))}
        <div className="actions">
          <button className="button secondary" onClick={onCancel}>
            取消
          </button>
          <button className="button" onClick={() => onConfirm(spec)}>
            {editing ? "确定" : "插入"}
          </button>
        </div>
      </div>
    </div>
  );
}
