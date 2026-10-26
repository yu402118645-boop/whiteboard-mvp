import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  getCommonBounds,
  newElementWith,
  restoreElements,
  sceneCoordsToViewportCoords,
} from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

// 选中元素后，在它下方弹出的快捷工具栏：颜色、字号、线条粗细、透明度。
// 只改元素本身的属性，不改 Excalidraw 源码；左侧自带的样式面板照常可用。

// 16 种常用色：第一排明亮色系，第二排马卡龙色系
const PALETTES: { name: string; colors: { name: string; hex: string }[] }[] = [
  {
    name: "明亮",
    colors: [
      { name: "黑", hex: "#1e1e1e" },
      { name: "红", hex: "#e03131" },
      { name: "橙", hex: "#f76707" },
      { name: "黄", hex: "#f59f00" },
      { name: "绿", hex: "#2f9e44" },
      { name: "青", hex: "#0c8599" },
      { name: "蓝", hex: "#1971c2" },
      { name: "紫", hex: "#7048e8" },
    ],
  },
  {
    name: "马卡龙",
    colors: [
      { name: "奶茶", hex: "#e6d5c3" },
      { name: "樱粉", hex: "#ffc2d1" },
      { name: "蜜桃", hex: "#ffd6a5" },
      { name: "柠黄", hex: "#fdffb6" },
      { name: "薄荷", hex: "#caffbf" },
      { name: "湖蓝", hex: "#9bf6ff" },
      { name: "天蓝", hex: "#a0c4ff" },
      { name: "薰衣草", hex: "#bdb2ff" },
    ],
  },
];
const BASES = PALETTES.flatMap((palette) => palette.colors);

/** 和白色或黑色按比例混合：amount 为正混白（变浅），为负混黑（变深） */
function mix(hex: string, amount: number): string {
  const target = amount > 0 ? 255 : 0;
  const k = Math.abs(amount);
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `#${channels.map((c) => Math.round(c + (target - c) * k).toString(16).padStart(2, "0")).join("")}`;
}
// 每种常用色的 5 级深浅：中间一级就是常用色本身
const SHADE_STEPS = [0.7, 0.4, 0, -0.25, -0.5];
const SHADES = BASES.map((base) => SHADE_STEPS.map((step) => (step === 0 ? base.hex : mix(base.hex, step))));

const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96, 120, 144];
const FONT_MIN = 4;
const FONT_MAX = 400;
const STROKE_WIDTHS = [1, 2, 4, 6];
// 有背景的图形；线条只有闭合时才会填充
const FILLABLE = new Set(["rectangle", "diamond", "ellipse", "line", "freedraw", "embeddable", "iframe"]);

type ColorKey = "strokeColor" | "backgroundColor";
type Panel = ColorKey | null;

type ToolbarState = {
  // 选中区域在屏幕上的位置
  centerX: number;
  selTop: number;
  selBottom: number;
  ids: string[];
  stroke: string;
  background: string | null;
  fontSize: number | null;
  strokeWidth: number | null;
  opacity: number;
};

const HEX = /^#?([0-9a-f]{6})$/i;

/** 把焦点还给画布（Excalidraw 的快捷键监听在它的容器上），输入框会因此失焦并提交 */
const focusCanvas = () => (document.querySelector(".excalidraw-container") as HTMLElement | null)?.focus();
const baseOf = (color: string) => SHADES.findIndex((shades) => shades.includes(color.toLowerCase()));

/** 选中的元素，加上容器里绑定的文字（选中方框时文字也要一起变色、变字号） */
function targets(elements: readonly ExcalidrawElement[], appState: AppState): ExcalidrawElement[] {
  const selected = new Set(Object.keys(appState.selectedElementIds).filter((id) => appState.selectedElementIds[id]));
  return elements.filter(
    (el) => !el.isDeleted && (selected.has(el.id) || (el.type === "text" && el.containerId && selected.has(el.containerId))),
  );
}

/** 拖动、缩放、画图、编辑文字的时候不显示，免得挡住 */
function busy(appState: AppState): boolean {
  return (
    appState.cursorButton === "down" ||
    !!appState.editingTextElement ||
    !!appState.newElement ||
    appState.isResizing ||
    appState.isRotating ||
    appState.selectedElementsAreBeingDragged ||
    !!appState.contextMenu ||
    !!appState.openDialog ||
    appState.viewModeEnabled
  );
}

function computeState(elements: readonly ExcalidrawElement[], appState: AppState): ToolbarState | null {
  if (busy(appState)) return null;
  const items = targets(elements, appState);
  if (items.length === 0) return null;
  const [x1, y1, x2, y2] = getCommonBounds(items);
  const topLeft = sceneCoordsToViewportCoords({ sceneX: x1, sceneY: y1 }, appState);
  const bottomRight = sceneCoordsToViewportCoords({ sceneX: x2, sceneY: y2 }, appState);
  const texts = items.filter((el) => el.type === "text");
  const shapes = items.filter((el) => el.type !== "text");
  const fillable = shapes.filter((el) => FILLABLE.has(el.type));
  const first = shapes[0] ?? items[0];
  return {
    centerX: (topLeft.x + bottomRight.x) / 2,
    selTop: topLeft.y,
    selBottom: bottomRight.y,
    ids: items.map((el) => el.id),
    stroke: first.strokeColor,
    background: fillable[0]?.backgroundColor ?? null,
    fontSize: texts[0] && "fontSize" in texts[0] ? texts[0].fontSize : null,
    strokeWidth: shapes[0]?.strokeWidth ?? null,
    opacity: first.opacity,
  };
}

export function QuickToolbar({ api }: { api: ExcalidrawImperativeAPI }) {
  const [state, setState] = useState<ToolbarState | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [base, setBase] = useState(0);
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const [fontDraft, setFontDraft] = useState<string | null>(null);
  const [fontOpen, setFontOpen] = useState(false);
  const lastKey = useRef("");
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // 量出工具栏实际大小，用来决定放在下方还是上方、以及不超出屏幕
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { offsetWidth: width, offsetHeight: height } = el;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  });

  // 打开字号列表时，把当前字号滚到可见位置
  useEffect(() => {
    if (fontOpen) box.current?.querySelector(".quick-font-list .selected")?.scrollIntoView({ block: "nearest" });
  }, [fontOpen]);

  useEffect(() => {
    const update = (elements: readonly ExcalidrawElement[], appState: AppState) => {
      const next = computeState(elements, appState);
      // onChange 很频繁（包括别人的光标动画），内容没变就不重新渲染
      const key = JSON.stringify(next);
      if (key === lastKey.current) return;
      const selectionChanged = next?.ids.join() !== (JSON.parse(lastKey.current || "null") as ToolbarState | null)?.ids.join();
      lastKey.current = key;
      setState(next);
      if (selectionChanged) {
        setPanel(null);
        setFontDraft(null);
        setFontOpen(false);
        setHexDraft(null);
      }
    };
    update(api.getSceneElements(), api.getAppState());
    return api.onChange(update);
  }, [api]);

  if (!state) return null;

  // 默认放在选中区域下方，下面放不下就放上方；左右、上下都不超出屏幕（手机底部留出 Excalidraw 的操作栏）
  const margin = 8;
  const bottomLimit = window.innerHeight - (window.innerWidth <= 640 ? 80 : margin);
  const below = state.selBottom + 16;
  const top = Math.max(
    margin,
    Math.min(below + size.height <= bottomLimit ? below : state.selTop - 16 - size.height, bottomLimit - size.height),
  );
  const left = Math.max(margin, Math.min(state.centerX - size.width / 2, window.innerWidth - size.width - margin));

  /** 改选中元素的属性；字号变化要重新算文字尺寸 */
  const apply = (
    change: (el: ExcalidrawElement) => Partial<ExcalidrawElement> | null,
    capture: "now" | "later" = "now",
  ) => {
    const ids = new Set(state.ids);
    const all = api.getSceneElementsIncludingDeleted();
    let changed = false;
    const next = all.map((el) => {
      if (!ids.has(el.id)) return el;
      const patch = change(el);
      if (!patch) return el;
      changed = true;
      return newElementWith(el, patch as never);
    });
    if (!changed) return;
    api.updateScene({
      elements: next,
      captureUpdate: capture === "now" ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.EVENTUALLY,
    });
  };

  const setColor = (key: ColorKey, color: string) => {
    apply((el) => {
      if (key === "backgroundColor" && !FILLABLE.has(el.type)) return null;
      return { [key]: color };
    });
  };

  const setFontSize = (size: number) => {
    const ids = new Set(state.ids);
    const all = api.getSceneElementsIncludingDeleted();
    const resized = all.map((el) => {
      if (!ids.has(el.id) || el.type !== "text") return el;
      // 单独的文字：字形按字号等比例缩放，宽高跟着缩放
      const ratio = size / el.fontSize;
      return newElementWith(el, {
        fontSize: size,
        ...(el.containerId ? {} : { width: el.width * ratio, height: el.height * ratio }),
      });
    });
    // 容器里的文字要按容器宽度重新换行。只把改到的文字和它们的容器交给 restore 处理，
    // 免得它顺手改动别的元素却没提升版本号，导致各端不一致
    const containerIds = new Set(
      resized.flatMap((el) => (ids.has(el.id) && el.type === "text" && el.containerId ? [el.containerId] : [])),
    );
    const affected = resized.filter((el) => (ids.has(el.id) && el.type === "text") || containerIds.has(el.id));
    const refreshed = new Map(
      fitContainers(restoreElements(affected, null, { refreshDimensions: true, repairBindings: true }), ids).map((el) => [
        el.id,
        el,
      ]),
    );
    api.updateScene({
      elements: resized.map((el) => refreshed.get(el.id) ?? el),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  const commitFont = () => {
    if (fontDraft === null) return;
    const value = Number(fontDraft);
    if (/^\d+$/.test(fontDraft.trim()) && value >= FONT_MIN && value <= FONT_MAX) {
      setFontSize(value);
      setFontDraft(null);
    }
  };
  const fontInvalid =
    fontDraft !== null && !(/^\d+$/.test(fontDraft.trim()) && Number(fontDraft) >= FONT_MIN && Number(fontDraft) <= FONT_MAX);

  const openPanel = (key: ColorKey) => {
    if (panel === key) {
      setPanel(null);
      return;
    }
    const current = key === "strokeColor" ? state.stroke : state.background ?? "";
    setBase(Math.max(0, baseOf(current)));
    setHexDraft(null);
    setFontOpen(false);
    setPanel(key);
  };

  const current = (panel === "strokeColor" ? state.stroke : state.background) ?? "";
  const pick = (color: string) => {
    if (!panel) return;
    const index = baseOf(color);
    if (index >= 0) setBase(index);
    setHexDraft(null);
    setColor(panel, color);
  };
  const commitHex = () => {
    if (hexDraft === null) return;
    const m = HEX.exec(hexDraft.trim());
    if (m) pick(`#${m[1].toLowerCase()}`);
  };
  const hexInvalid = hexDraft !== null && !HEX.test(hexDraft.trim());

  // 字号列表：工具栏在屏幕下半部分时往上展开
  const fontUp = top > window.innerHeight / 2;
  const stepFont = (dir: 1 | -1) => {
    const now = state.fontSize ?? 20;
    const next = dir > 0 ? FONT_SIZES.find((v) => v > now) : [...FONT_SIZES].reverse().find((v) => v < now);
    if (next) setFontSize(next);
  };

  return (
    <div
      ref={box}
      className="quick-toolbar"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      // 点按钮不抢走焦点，Enter、Delete 等快捷键仍然作用在画布上（输入框除外）
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      <div className="quick-row">
        <button
          className={`quick-color${panel === "strokeColor" ? " active" : ""}`}
          title="线条颜色"
          onClick={() => openPanel("strokeColor")}
        >
          <span className="swatch-dot stroke" style={{ borderColor: state.stroke }} />
          线条
        </button>
        {state.background !== null && (
          <button
            className={`quick-color${panel === "backgroundColor" ? " active" : ""}`}
            title="背景颜色"
            onClick={() => openPanel("backgroundColor")}
          >
            <span
              className={`swatch-dot${state.background === "transparent" ? " transparent" : ""}`}
              style={{ background: state.background === "transparent" ? undefined : state.background }}
            />
            背景
          </button>
        )}
        {state.fontSize !== null && (
          <div className="quick-font" title="字号：从列表选，或直接输入后按回车；上下方向键切换">
            <span>字号</span>
            <div className="quick-font-box">
              <input
                type="text"
                inputMode="numeric"
                className={fontInvalid ? "invalid" : ""}
                value={fontDraft ?? String(Math.round(state.fontSize))}
                onFocus={(e) => {
                  e.target.select();
                  setPanel(null);
                  setFontOpen(true);
                }}
                onClick={() => setFontOpen(true)}
                onChange={(e) => setFontDraft(e.target.value)}
                onBlur={() => {
                  commitFont();
                  setFontOpen(false);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    focusCanvas();
                  } else if (e.key === "Escape") {
                    setFontDraft(null);
                    focusCanvas();
                  } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                    e.preventDefault();
                    setFontDraft(null);
                    stepFont(e.key === "ArrowUp" ? 1 : -1);
                  }
                }}
              />
              {fontOpen && (
                <ul className={`quick-font-list${fontUp ? " up" : ""}`}>
                  {FONT_SIZES.map((size) => (
                    <li
                      key={size}
                      className={Math.round(state.fontSize!) === size ? "selected" : ""}
                      // 按下时不让输入框失去焦点，否则列表会先关掉
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setFontSize(size);
                        setFontDraft(null);
                        setFontOpen(false);
                      }}
                    >
                      {size}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        {state.strokeWidth !== null && (
          <div className="quick-widths" title="线条粗细">
            {STROKE_WIDTHS.map((width) => (
              <button
                key={width}
                className={state.strokeWidth === width ? "active" : ""}
                title={`粗细 ${width}`}
                onClick={() => apply((el) => (el.type === "text" ? null : { strokeWidth: width }))}
              >
                <span style={{ height: Math.max(1, width) }} />
              </button>
            ))}
          </div>
        )}
        <label className="quick-opacity" title="透明度">
          <span>透明度</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={state.opacity}
            onChange={(e) => apply(() => ({ opacity: Number(e.target.value) }), "later")}
            onPointerUp={(e) => apply(() => ({ opacity: Number((e.target as HTMLInputElement).value) }))}
          />
          <span className="quick-value">{state.opacity}%</span>
        </label>
      </div>
      {fontInvalid && <p className="field-error">字号请输入 {FONT_MIN}～{FONT_MAX} 之间的整数</p>}
      {panel && (
        <div className="quick-palette">
          {PALETTES.map((palette, row) => (
            <div key={palette.name} className="quick-palette-row">
              <span className="quick-label">{palette.name}</span>
              <div className="quick-swatches">
                {palette.colors.map((color, i) => {
                  const index = row * 8 + i;
                  return (
                    <button
                      key={color.hex}
                      className={`quick-swatch${current.toLowerCase() === color.hex ? " selected" : index === base && SHADES[index].includes(current.toLowerCase()) ? " related" : ""}`}
                      style={{ background: color.hex }}
                      title={`${color.name} ${color.hex}`}
                      onClick={() => pick(color.hex)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
          <div className="quick-palette-row">
            <span className="quick-label">深浅</span>
            <div className="quick-shades" title={`${BASES[base].name}的 5 级深浅`}>
              {SHADES[base].map((shade, i) => (
                <button
                  key={shade}
                  className={`quick-shade${current.toLowerCase() === shade ? " selected" : ""}`}
                  style={{ background: shade }}
                  title={`${["最浅", "浅", "标准", "深", "最深"][i]} ${shade}`}
                  onClick={() => pick(shade)}
                />
              ))}
            </div>
          </div>
          <div className="quick-palette-row quick-custom">
            <span className="quick-label">自定义</span>
            <label className="quick-picker" title="打开取色器">
              <span
                className={`quick-current${current === "transparent" ? " transparent" : ""}`}
                style={{ background: current === "transparent" ? undefined : current }}
              />
              <input
                type="color"
                value={HEX.test(current) ? current : "#000000"}
                onChange={(e) => pick(e.target.value)}
              />
            </label>
            <input
              type="text"
              className={`quick-hex${hexInvalid ? " invalid" : ""}`}
              value={hexDraft ?? (current === "transparent" ? "" : current.toUpperCase())}
              placeholder="#RRGGBB"
              maxLength={7}
              onChange={(e) => setHexDraft(e.target.value)}
              onBlur={commitHex}
              onKeyDown={(e) => {
                e.stopPropagation();
                // 回车后把焦点还给画布，快捷键才能继续用
                if (e.key === "Enter") focusCanvas();
              }}
            />
            {panel === "backgroundColor" && (
              <button
                className={`quick-none${current === "transparent" ? " selected" : ""}`}
                title="无填充"
                onClick={() => pick("transparent")}
              >
                <span className="quick-current transparent" />
                透明
              </button>
            )}
          </div>
          {hexInvalid && <p className="field-error">请输入 6 位色号，例如 #FF8800</p>}
        </div>
      )}
    </div>
  );
}

// 容器中文字的内边距（和 Excalidraw 一致）
const BOUND_TEXT_PADDING = 5;

/** 字号变大后，文字放不下就把容器撑高，并把文字重新居中 */
function fitContainers(elements: readonly ExcalidrawElement[], ids: Set<string>): ExcalidrawElement[] {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const updates = new Map<string, ExcalidrawElement>();
  for (const text of elements) {
    if (!ids.has(text.id) || text.type !== "text" || !text.containerId) continue;
    const container = byId.get(text.containerId);
    if (!container) continue;
    // 椭圆、菱形能放文字的区域比外框小
    const inset =
      container.type === "ellipse" ? (1 - Math.SQRT1_2) / 2 : container.type === "diamond" ? 0.25 : 0;
    const innerHeight = container.height * (1 - inset * 2) - BOUND_TEXT_PADDING * 2;
    let height = container.height;
    if (text.height > innerHeight) {
      height = (text.height + BOUND_TEXT_PADDING * 2) / (1 - inset * 2);
      updates.set(container.id, newElementWith(container, { height }));
    }
    const innerX = container.x + container.width * inset + BOUND_TEXT_PADDING;
    const innerY = container.y + height * inset + BOUND_TEXT_PADDING;
    const innerW = container.width * (1 - inset * 2) - BOUND_TEXT_PADDING * 2;
    const innerH = height * (1 - inset * 2) - BOUND_TEXT_PADDING * 2;
    const x =
      text.textAlign === "left" ? innerX : text.textAlign === "right" ? innerX + innerW - text.width : innerX + (innerW - text.width) / 2;
    const y =
      text.verticalAlign === "top" ? innerY : text.verticalAlign === "bottom" ? innerY + innerH - text.height : innerY + (innerH - text.height) / 2;
    updates.set(text.id, { ...text, x, y } as ExcalidrawElement);
  }
  return elements.map((el) => updates.get(el.id) ?? el);
}
