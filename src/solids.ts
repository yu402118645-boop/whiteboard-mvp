// 3D 体：用 Excalidraw 原生的线条和椭圆拼出立方体、圆柱、圆锥、球，并组合成一个整体。
// 因为是普通元素，线条颜色、背景、透明度、填充样式都能照常修改；
// 尺寸记在 customData 里，选中后可以重新打开面板修改。

import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export type SolidType = "cube" | "cylinder" | "cone" | "sphere";
export type SolidSize = { w: number; h: number; d: number };
export type SolidSpec = { type: SolidType } & SolidSize;

export const SOLID_LABELS: Record<SolidType, string> = {
  cube: "立方体",
  cylinder: "圆柱",
  cone: "圆锥",
  sphere: "球",
};

// 每种 3D 体的三个尺寸分别叫什么
export const SIZE_LABELS: Record<SolidType, [string, string, string]> = {
  cube: ["长", "高", "宽（进深）"],
  cylinder: ["直径", "高", "底面透视"],
  cone: ["底面直径", "高", "底面透视"],
  sphere: ["宽", "高", "赤道透视"],
};

export const DEFAULT_SIZE: Record<SolidType, SolidSize> = {
  cube: { w: 160, h: 120, d: 120 },
  cylinder: { w: 140, h: 160, d: 140 },
  cone: { w: 140, h: 160, d: 140 },
  sphere: { w: 160, h: 160, d: 140 },
};

export const SIZE_MIN = 20;
export const SIZE_MAX = 800;

// 半透明的浅蓝背景：叠在一起的面和背面的虚线都能透出来，立体感更强
export const DEFAULT_SOLID_BACKGROUND = "#a5d8ff80";

type Point = [number, number];

export type SolidPart =
  | { role: string; kind: "path"; points: Point[]; closed: boolean; dashed: boolean }
  | { role: string; kind: "ellipse"; x: number; y: number; width: number; height: number };

// 斜二测画法：进深方向 45° 向右上，长度取一半
const DEPTH_FACTOR = Math.SQRT1_2 / 2;
// 圆形底面的透视：椭圆竖向半径 = 进深 × 这个系数
const ELLIPSE_FACTOR = 0.25;
const ARC_SEGMENTS = 24;

/** 椭圆上一段弧：角度从 from 到 to（弧度，y 轴向下，0~π 是靠近观察者的下半段） */
function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Point[] {
  return Array.from({ length: ARC_SEGMENTS + 1 }, (_, i) => {
    const t = from + ((to - from) * i) / ARC_SEGMENTS;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)] as Point;
  });
}

/** 3D 体的各个部分，坐标以包围盒左上角为原点；先画的在下层 */
export function solidParts({ type, w, h, d }: SolidSpec): SolidPart[] {
  switch (type) {
    case "cube": {
      const o = d * DEPTH_FACTOR;
      const hiddenCorner: Point = [o, h];
      return [
        { role: "hidden", kind: "path", points: [hiddenCorner, [o, 0]], closed: false, dashed: true },
        { role: "hidden", kind: "path", points: [hiddenCorner, [w + o, h]], closed: false, dashed: true },
        { role: "hidden", kind: "path", points: [hiddenCorner, [0, h + o]], closed: false, dashed: true },
        { role: "face", kind: "path", points: [[0, o], [w, o], [w, o + h], [0, o + h]], closed: true, dashed: false },
        { role: "face", kind: "path", points: [[0, o], [o, 0], [w + o, 0], [w, o]], closed: true, dashed: false },
        { role: "face", kind: "path", points: [[w, o], [w + o, 0], [w + o, h], [w, o + h]], closed: true, dashed: false },
      ];
    }
    case "cylinder": {
      const rx = w / 2;
      const ry = Math.max(2, d * ELLIPSE_FACTOR);
      const body = [
        ...arc(rx, ry + h, rx, ry, Math.PI, 0),
        ...arc(rx, ry, rx, ry, 0, Math.PI),
      ];
      return [
        { role: "hidden", kind: "path", points: arc(rx, ry + h, rx, ry, Math.PI, 2 * Math.PI), closed: false, dashed: true },
        { role: "face", kind: "path", points: body, closed: true, dashed: false },
        { role: "face", kind: "ellipse", x: 0, y: 0, width: w, height: ry * 2 },
      ];
    }
    case "cone": {
      const rx = w / 2;
      const ry = Math.max(2, d * ELLIPSE_FACTOR);
      const apex: Point = [rx, 0];
      return [
        { role: "hidden", kind: "path", points: arc(rx, h, rx, ry, Math.PI, 2 * Math.PI), closed: false, dashed: true },
        { role: "face", kind: "path", points: [apex, ...arc(rx, h, rx, ry, Math.PI, 0)], closed: true, dashed: false },
      ];
    }
    case "sphere": {
      const ry = Math.max(2, d * ELLIPSE_FACTOR);
      return [
        { role: "face", kind: "ellipse", x: 0, y: 0, width: w, height: h },
        { role: "hidden", kind: "path", points: arc(w / 2, h / 2, w / 2, ry, Math.PI, 2 * Math.PI), closed: false, dashed: true },
        { role: "edge", kind: "path", points: arc(w / 2, h / 2, w / 2, ry, 0, Math.PI), closed: false, dashed: false },
      ];
    }
  }
}

export type SolidStyle = {
  strokeColor: string;
  backgroundColor: string;
  fillStyle: ExcalidrawElement["fillStyle"];
  strokeWidth: number;
  roughness: number;
  opacity: number;
};

function randomId(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** 生成可以直接放进画布的元素（同一个组） */
export function createSolidElements(
  spec: SolidSpec,
  origin: { x: number; y: number },
  style: SolidStyle,
  groupId = randomId(),
): ExcalidrawElement[] {
  const common = {
    strokeColor: style.strokeColor,
    strokeWidth: style.strokeWidth,
    roughness: style.roughness,
    opacity: style.opacity,
    groupIds: [groupId],
  };
  const skeletons = solidParts(spec).map((part) => {
    const customData = { solid: { type: spec.type, w: spec.w, h: spec.h, d: spec.d }, role: part.role };
    const filled = part.role === "face";
    const fill = {
      backgroundColor: filled ? style.backgroundColor : "transparent",
      fillStyle: style.fillStyle,
    };
    if (part.kind === "ellipse") {
      return {
        type: "ellipse" as const,
        x: origin.x + part.x,
        y: origin.y + part.y,
        width: part.width,
        height: part.height,
        ...common,
        ...fill,
        customData,
      };
    }
    const [x0, y0] = part.points[0];
    const points = part.points.map(([x, y]) => [x - x0, y - y0] as Point);
    // 首尾相同的线条在 Excalidraw 里是封闭图形，才能填充背景
    if (part.closed) points.push([0, 0]);
    // 必须显式给出包围盒尺寸：不给的话会按默认值（宽 100、高 0）记录，
    // 一拉伸，曲线上的点就会按高度 0 缩放，塌成一条直线
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    return {
      type: "line" as const,
      x: origin.x + x0,
      y: origin.y + y0,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      points,
      strokeStyle: part.dashed ? ("dashed" as const) : ("solid" as const),
      ...common,
      ...fill,
      customData,
    };
  });
  return convertToExcalidrawElements(skeletons as Parameters<typeof convertToExcalidrawElements>[0], {
    regenerateIds: true,
  });
}

/** 选中的元素正好是一个完整的 3D 体时，返回它的组 ID 和尺寸 */
export function findSelectedSolid(
  elements: readonly ExcalidrawElement[],
  selectedIds: Readonly<Record<string, true>>,
): { groupId: string; spec: SolidSpec; members: ExcalidrawElement[] } | null {
  const selected = elements.filter((el) => selectedIds[el.id] && !el.isDeleted);
  const first = selected[0];
  const spec = first?.customData?.solid as SolidSpec | undefined;
  // 3D 体自己的组是最内层的组（groupIds[0]）；复制粘贴后组 ID 会重新生成，不会和原件混在一起
  const groupId = first?.groupIds[0];
  if (!spec || !groupId) return null;
  if (!selected.every((el) => el.customData?.solid && el.groupIds[0] === groupId)) return null;
  const members = elements.filter((el) => !el.isDeleted && el.groupIds[0] === groupId);
  return { groupId, spec, members };
}

/** 从已有的 3D 体上取样式，修改尺寸时保留 */
export function styleOf(members: readonly ExcalidrawElement[]): SolidStyle {
  const face = members.find((el) => el.customData?.role === "face") ?? members[0];
  return {
    strokeColor: face.strokeColor,
    backgroundColor: face.backgroundColor,
    fillStyle: face.fillStyle,
    strokeWidth: face.strokeWidth,
    roughness: face.roughness,
    opacity: face.opacity,
  };
}

/**
 * 修复早期版本插入的 3D 体：当时线条没记录正确的包围盒尺寸，一拉伸就会塌成直线。
 * 返回需要更新的元素（已提升版本号），没有需要修的就返回空数组。
 */
export function repairSolids(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  const fixed: ExcalidrawElement[] = [];
  for (const el of elements) {
    if (el.isDeleted || el.type !== "line" || !el.customData?.solid) continue;
    const xs = el.points.map(([x]) => x);
    const ys = el.points.map(([, y]) => y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    if (Math.abs(width - el.width) < 0.5 && Math.abs(height - el.height) < 0.5) continue;
    fixed.push({
      ...el,
      width,
      height,
      version: el.version + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    });
  }
  return fixed;
}
