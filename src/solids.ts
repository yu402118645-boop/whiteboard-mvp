// 3D 体：用 Excalidraw 原生的线条和椭圆拼出立方体、圆柱、圆锥（圆台）、棱锥（棱台）、球，并组合成一个整体。
// 因为是普通元素，线条颜色、背景、透明度、填充样式都能照常修改；
// 尺寸记在 customData 里，选中后可以重新打开面板修改。

import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export type SolidType = "cube" | "cylinder" | "cone" | "pyramid" | "sphere";
// cut：从顶部截掉的高度（圆锥、棱锥用），0 表示尖顶，大于 0 就成了圆台 / 棱台
export type SolidSize = { w: number; h: number; d: number; cut?: number };
// sides：棱锥底面的边数
export type SolidSpec = { type: SolidType; sides?: 3 | 4 } & SolidSize;

export const SOLID_LABELS: Record<SolidType, string> = {
  cube: "立方体",
  cylinder: "圆柱",
  cone: "圆锥",
  pyramid: "棱锥",
  sphere: "球",
};

/** 具体名称：截了顶的圆锥叫圆台，棱锥分三棱锥 / 四棱台等 */
export function solidName(spec: SolidSpec): string {
  const cut = (spec.cut ?? 0) > 0;
  if (spec.type === "cone") return cut ? "圆台" : "圆锥";
  if (spec.type === "pyramid") return `${spec.sides === 3 ? "三" : "四"}${cut ? "棱台" : "棱锥"}`;
  return SOLID_LABELS[spec.type];
}

// 每种 3D 体的三个尺寸分别叫什么
export const SIZE_LABELS: Record<SolidType, [string, string, string]> = {
  cube: ["长", "高", "宽（进深）"],
  cylinder: ["直径", "高", "底面透视"],
  cone: ["底面直径", "高", "底面透视"],
  pyramid: ["底面长", "高", "底面宽（进深）"],
  sphere: ["宽", "高", "赤道透视"],
};

export const DEFAULT_SIZE: Record<SolidType, SolidSize & { sides?: 3 | 4 }> = {
  cube: { w: 120, h: 120, d: 120 },
  cylinder: { w: 140, h: 160, d: 140 },
  cone: { w: 140, h: 160, d: 140, cut: 0 },
  pyramid: { w: 160, h: 160, d: 140, cut: 0, sides: 4 },
  sphere: { w: 160, h: 160, d: 140 },
};

/** 支持截顶的类型 */
export const CUTTABLE: SolidType[] = ["cone", "pyramid"];

export const SIZE_MIN = 20;
export const SIZE_MAX = 800;
export const CUT_MAX = 800;

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
export function solidParts(spec: SolidSpec): SolidPart[] {
  const { type, w, h, d } = spec;
  // 截顶比例：顶面尺寸 / 底面尺寸。按「完整锥体高 = 可见高度 + 截掉高度」的相似三角形计算
  const cut = Math.max(0, spec.cut ?? 0);
  const k = cut / (h + cut);
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
      if (k === 0) {
        const apex: Point = [rx, 0];
        return [
          { role: "hidden", kind: "path", points: arc(rx, h, rx, ry, Math.PI, 2 * Math.PI), closed: false, dashed: true },
          { role: "face", kind: "path", points: [apex, ...arc(rx, h, rx, ry, Math.PI, 0)], closed: true, dashed: false },
        ];
      }
      // 圆台：顶面是缩小的椭圆，侧面由底面前半弧和顶面前半弧围成
      const tx = rx * k;
      const ty = Math.max(1, ry * k);
      const body = [...arc(rx, ty + h, rx, ry, Math.PI, 0), ...arc(rx, ty, tx, ty, 0, Math.PI)];
      return [
        { role: "hidden", kind: "path", points: arc(rx, ty + h, rx, ry, Math.PI, 2 * Math.PI), closed: false, dashed: true },
        { role: "face", kind: "path", points: body, closed: true, dashed: false },
        { role: "face", kind: "ellipse", x: rx - tx, y: 0, width: tx * 2, height: ty * 2 },
      ];
    }
    case "pyramid":
      return polyhedronParts(pyramidFaces(w, h, d, spec.sides ?? 4, k));
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

type Vec3 = [number, number, number];

/** 棱锥 / 棱台的各个面（三维坐标：x 向右，y 向上，z 向里） */
function pyramidFaces(w: number, h: number, d: number, sides: 3 | 4, k: number): Vec3[][] {
  const base: Vec3[] =
    sides === 3
      ? [[0, 0, 0], [w, 0, 0], [w / 2, 0, d]]
      : [[0, 0, 0], [w, 0, 0], [w, 0, d], [0, 0, d]];
  // 顶点在底面中心（三角形取重心）正上方
  const cx = base.reduce((sum, p) => sum + p[0], 0) / base.length;
  const cz = base.reduce((sum, p) => sum + p[2], 0) / base.length;
  if (k === 0) {
    const apex: Vec3 = [cx, h, cz];
    return [base, ...base.map((p, i) => [p, base[(i + 1) % base.length], apex])];
  }
  const top: Vec3[] = base.map(([x, , z]) => [cx + (x - cx) * k, h, cz + (z - cz) * k]);
  return [
    base,
    top,
    ...base.map((p, i) => {
      const j = (i + 1) % base.length;
      return [p, base[j], top[j], top[i]];
    }),
  ];
}

/**
 * 通用多面体画法：朝向观察者的面画成填充的多边形，
 * 只属于背面的棱画成虚线。观察方向与立方体一致（从右上前方看）。
 */
function polyhedronParts(faces: Vec3[][]): SolidPart[] {
  const project = ([x, y, z]: Vec3): Point => [x + z * DEPTH_FACTOR, -y - z * DEPTH_FACTOR];
  // 斜二测投影的投射方向；面的外法线和它点积为负就是朝向观察者
  const view: Vec3 = [-DEPTH_FACTOR, -DEPTH_FACTOR, 1];
  const all = faces.flat();
  const center = all.reduce<Vec3>((c, p) => [c[0] + p[0] / all.length, c[1] + p[1] / all.length, c[2] + p[2] / all.length], [0, 0, 0]);
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  const visible = faces.map((face) => {
    let normal = cross(sub(face[1], face[0]), sub(face[2], face[0]));
    const faceCenter = face.reduce<Vec3>((c, p) => [c[0] + p[0] / face.length, c[1] + p[1] / face.length, c[2] + p[2] / face.length], [0, 0, 0]);
    if (dot(normal, sub(faceCenter, center)) < 0) normal = [-normal[0], -normal[1], -normal[2]];
    return dot(normal, view) < -1e-9;
  });

  const key = (a: Vec3, b: Vec3) => [a, b].map((p) => p.map((v) => v.toFixed(3)).join(",")).sort().join("|");
  const visibleEdges = new Set<string>();
  const hiddenEdges = new Map<string, [Vec3, Vec3]>();
  faces.forEach((face, i) => {
    face.forEach((p, j) => {
      const q = face[(j + 1) % face.length];
      if (visible[i]) visibleEdges.add(key(p, q));
      else hiddenEdges.set(key(p, q), [p, q]);
    });
  });

  // 统一平移到以包围盒左上角为原点
  const projected = all.map(project);
  const minX = Math.min(...projected.map((p) => p[0]));
  const minY = Math.min(...projected.map((p) => p[1]));
  const P = (p: Vec3): Point => {
    const [x, y] = project(p);
    return [x - minX, y - minY];
  };

  const parts: SolidPart[] = [];
  for (const [k, [a, b]] of hiddenEdges) {
    if (!visibleEdges.has(k)) parts.push({ role: "hidden", kind: "path", points: [P(a), P(b)], closed: false, dashed: true });
  }
  faces.forEach((face, i) => {
    if (visible[i]) parts.push({ role: "face", kind: "path", points: face.map(P), closed: true, dashed: false });
  });
  return parts;
}

/**
 * 插入面板预览图上三个拖动手柄的位置（局部坐标）和拖动方向。
 * axis 是屏幕上的拖动方向，factor 是沿该方向拖动 1 个单位时尺寸变化多少。
 */
export function sizeHandles(spec: SolidSpec): { dim: "w" | "h" | "d"; at: Point; axis: Point; factor: number }[] {
  const { type, w, h, d } = spec;
  const diagonal: Point = [Math.SQRT1_2, -Math.SQRT1_2];
  if (type === "cube") {
    const o = d * DEPTH_FACTOR;
    return [
      { dim: "w", at: [w, o + h / 2], axis: [1, 0], factor: 1 },
      { dim: "h", at: [w / 2, o], axis: [0, -1], factor: 1 },
      { dim: "d", at: [w + o, 0], axis: diagonal, factor: 2 },
    ];
  }
  if (type === "pyramid") {
    // 取各部分的包围盒：右下是长，顶部是高，右上是进深
    const points = solidParts(spec).flatMap((part) => (part.kind === "path" ? part.points : []));
    const maxX = Math.max(...points.map((p) => p[0]));
    const maxY = Math.max(...points.map((p) => p[1]));
    const o = d * DEPTH_FACTOR;
    return [
      { dim: "w", at: [w, maxY], axis: [1, 0], factor: 1 },
      { dim: "h", at: [points.find((p) => p[1] === 0)![0], 0], axis: [0, -1], factor: 1 },
      { dim: "d", at: [maxX, maxY - o], axis: diagonal, factor: 2 },
    ];
  }
  const ry = d * ELLIPSE_FACTOR;
  const k = (spec.cut ?? 0) / (h + (spec.cut ?? 0));
  const top = type === "cone" && k > 0 ? ry * k : 0;
  const bottom = type === "cylinder" ? ry + h : type === "cone" ? top + h : h / 2;
  return [
    { dim: "w", at: [w, type === "sphere" ? h / 2 : type === "cylinder" ? ry + h / 2 : bottom], axis: [1, 0], factor: 1 },
    { dim: "h", at: [w / 2, 0], axis: [0, -1], factor: 1 },
    { dim: "d", at: [w / 2, bottom + ry], axis: [0, 1], factor: 4 },
  ];
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
    const customData = { solid: { ...spec }, role: part.role };
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
