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

// 8 种常用色，每种 5 级由浅到深（取自 Excalidraw 默认色板用的 Open Color）
const HUES: { name: string; shades: string[] }[] = [
  { name: "黑", shades: ["#ffffff", "#ced4da", "#868e96", "#495057", "#1e1e1e"] },
  { name: "红", shades: ["#fff5f5", "#ffc9c9", "#ff8787", "#fa5252", "#e03131"] },
  { name: "橙", shades: ["#fff4e6", "#ffd8a8", "#ffa94d", "#fd7e14", "#e8590c"] },
  { name: "黄", shades: ["#fff9db", "#ffec99", "#ffd43b", "#fab005", "#f08c00"] },
  { name: "绿", shades: ["#ebfbee", "#b2f2bb", "#69db7c", "#40c057", "#2f9e44"] },
  { name: "青", shades: ["#e6fcf5", "#96f2d7", "#38d9a9", "#12b886", "#099268"] },
  { name: "蓝", shades: ["#e7f5ff", "#a5d8ff", "#4dabf7", "#228be6", "#1971c2"] },
  { name: "紫", shades: ["#f3f0ff", "#d0bfff", "#9775fa", "#7950f2", "#6741d9"] },
];
// 点色相时默认用哪一级：线条用深色，背景用浅色
const DEFAULT_SHADE = { strokeColor: 4, backgroundColor: 1 } as const;

const FONT_SIZES = [12, 14, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96, 128];
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

const hueOf = (color: string) => HUES.findIndex((hue) => hue.shades.includes(color.toLowerCase()));

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
  const [hue, setHue] = useState(0);
  const [fontDraft, setFontDraft] = useState<string | null>(null);
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
    const index = hueOf(current);
    setHue(index >= 0 ? index : key === "strokeColor" ? 0 : 6);
    setPanel(key);
  };

  const current = panel === "strokeColor" ? state.stroke : state.background;

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
          <label className="quick-font" title="字号：可以从列表选，也可以直接输入">
            <span>字号</span>
            <input
              type="text"
              inputMode="numeric"
              list="quick-font-sizes"
              className={fontInvalid ? "invalid" : ""}
              value={fontDraft ?? String(Math.round(state.fontSize))}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                const text = e.target.value;
                setFontDraft(text);
                // 从下拉列表里选中时直接生效
                if (FONT_SIZES.includes(Number(text)) && (e.nativeEvent as InputEvent).inputType !== "insertText") {
                  setFontSize(Number(text));
                  setFontDraft(null);
                }
              }}
              onBlur={commitFont}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitFont();
                e.stopPropagation();
              }}
            />
            <datalist id="quick-font-sizes">
              {FONT_SIZES.map((size) => (
                <option key={size} value={size} />
              ))}
            </datalist>
          </label>
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
          <div className="quick-hues">
            {panel === "backgroundColor" && (
              <button
                className={`quick-swatch transparent${current === "transparent" ? " selected" : ""}`}
                title="透明"
                onClick={() => setColor("backgroundColor", "transparent")}
              />
            )}
            {HUES.map((h, i) => (
              <button
                key={h.name}
                className={`quick-swatch${i === hue ? " selected" : ""}`}
                style={{ background: h.shades[DEFAULT_SHADE[panel]] }}
                title={h.name}
                onClick={() => {
                  setHue(i);
                  setColor(panel, h.shades[DEFAULT_SHADE[panel]]);
                }}
              />
            ))}
          </div>
          <div className="quick-shades">
            {HUES[hue].shades.map((shade) => (
              <button
                key={shade}
                className={`quick-swatch shade${current?.toLowerCase() === shade ? " selected" : ""}`}
                style={{ background: shade }}
                title={shade}
                onClick={() => setColor(panel, shade)}
              />
            ))}
            <input
              type="color"
              title="自定义颜色"
              value={/^#[0-9a-f]{6}$/i.test(current ?? "") ? current! : "#000000"}
              onChange={(e) => setColor(panel, e.target.value)}
            />
          </div>
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
