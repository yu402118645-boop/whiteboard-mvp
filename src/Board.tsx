import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  getCommonBounds,
  getVisibleSceneBounds,
  MainMenu,
  reconcileElements,
  useHandleLibrary,
  zoomToFitBounds,
} from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { BoardSync, type ConnectionStatus, type RemotePointer, type ViewportBounds } from "./sync";
import { StatusBadge } from "./StatusBadge";
import { NameDialog } from "./NameDialog";
import { clientId, getName, saveName } from "./identity";
import { getSnapshot, renameBoard, type SnapshotSummary } from "./api";
import { HistoryDialog } from "./HistoryDialog";
import { downloadFile, uploadFile } from "./files";
import { libraryAdapter } from "./library";
import { SolidDialog } from "./SolidDialog";
import {
  createSolidElements,
  CUT_MAX,
  DEFAULT_SIZE,
  DEFAULT_SOLID_BACKGROUND,
  findSelectedSolid,
  repairSolids,
  SIZE_MAX,
  SIZE_MIN,
  styleOf,
  type SolidSpec,
} from "./solids";

// 本地也缓存一份，离线时刷新页面不丢修改，重连后再补发到服务器
const cacheKey = (boardId: string) => `whiteboard:${boardId}`;

function loadCache(boardId: string): ExcalidrawElement[] {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(boardId)) ?? "[]");
  } catch {
    return [];
  }
}

function saveCache(boardId: string, elements: readonly ExcalidrawElement[]): void {
  try {
    localStorage.setItem(cacheKey(boardId), JSON.stringify(elements));
  } catch {
    // 存储已满或被禁用时忽略，服务器上仍有数据
  }
}

// 把绘制过程中的高频变化合并后再发送，控制免费额度内的消息数量
const SEND_THROTTLE_MS = 80;
// 鼠标位置每秒最多发 5 次：光标会有点跳，但消息量只有不限速时的几分之一
const POINTER_THROTTLE_MS = 150;
// 被人跟随时，自己的视野范围最多这么久发一次（只在拖动、缩放画布时发）
const VIEWPORT_THROTTLE_MS = 150;
const CACHE_THROTTLE_MS = 1000;
const FILE_RETRY_MS = 2000;
const FILE_MAX_RETRIES = 15;

type Dialog = "nickname" | "rename" | "history" | null;

function randomNonce(): number {
  return Math.floor(Math.random() * 2 ** 31);
}


/**
 * 3D 体在画布上可能被直接拖边框拉伸过，记录的尺寸就过时了。
 * 打开「修改尺寸」前按当前实际大小换算，免得一确认就变回原来的大小。
 */
function currentSolidSpec(solid: NonNullable<ReturnType<typeof findSelectedSolid>>): SolidSpec {
  const { spec, members } = solid;
  const [ex0, ey0, ex1, ey1] = getCommonBounds(createSolidElements(spec, { x: 0, y: 0 }, styleOf(members)));
  const [ax0, ay0, ax1, ay1] = getCommonBounds(members);
  const sx = (ax1 - ax0) / (ex1 - ex0);
  const sy = (ay1 - ay0) / (ey1 - ey0);
  if (!(sx > 0 && sy > 0) || (Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01)) return spec;
  // 进深同时影响宽和高，取两个方向缩放的平均
  const size = (v: number, scale: number) => Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, v * scale)));
  return {
    ...spec,
    w: size(spec.w, sx),
    h: size(spec.h, sy),
    d: size(spec.d, (sx + sy) / 2),
    ...(spec.cut !== undefined && { cut: Math.round(Math.min(CUT_MAX, spec.cut * sy)) }),
  };
}

export function Board({ boardId }: { boardId: string }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "connecting", attempt: 0 });
  const [pending, setPending] = useState(0);
  const [nickname, setNickname] = useState(getName);
  const [boardName, setBoardName] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  // 当前选中的 3D 体（用于「修改尺寸」）；solidDialog 为 null 表示面板关闭
  const [selectedSolid, setSelectedSolid] = useState<ReturnType<typeof findSelectedSolid>>(null);
  const [solidDialog, setSolidDialog] = useState<{
    spec: SolidSpec;
    background: string;
    editing: boolean;
  } | null>(null);
  const initialData = useMemo(
    () => ({
      elements: loadCache(boardId),
      appState: {
        // 箭头默认用肘形：自动走折线，适合画流程图
        currentItemArrowType: "elbow" as const,
        // 图形默认白色实心背景，叠在别的东西上时不会透出来
        currentItemBackgroundColor: "#ffffff",
        currentItemFillStyle: "solid" as const,
      },
      scrollToContent: true,
    }),
    [boardId],
  );

  // 服务器已确认拥有的每个元素版本；本地版本与之不同的元素就是待发送的修改
  const syncedVersions = useRef(new Map<string, number>());
  const syncRef = useRef<BoardSync | null>(null);
  const sendTimer = useRef<number | undefined>(undefined);
  const cacheTimer = useRef<number | undefined>(undefined);
  const latestElements = useRef<readonly ExcalidrawElement[]>([]);
  const collaborators = useRef(new Map<SocketId, Collaborator>());
  const pointerTimer = useRef<number | undefined>(undefined);
  const latestPointer = useRef<Omit<RemotePointer, "cid" | "name"> | null>(null);
  // 别人的光标每 150 毫秒才收到一次，中间用动画平滑过渡，看起来不跳（不增加任何流量）
  const pointerAnims = useRef(new Map<SocketId, { from: { x: number; y: number }; to: { x: number; y: number }; start: number }>());
  const pointerFrame = useRef<number | undefined>(undefined);
  // 跟随视角：我正在跟随谁、谁在跟随我
  const following = useRef<string | null>(null);
  const followers = useRef(new Set<string>());
  const viewportTimer = useRef<number | undefined>(undefined);
  const lastViewport = useRef("");
  // 图片：服务器已有的、正在上传的、正在下载的
  const uploadedFiles = useRef(new Set<string>());
  const uploadingFiles = useRef(new Set<string>());
  const downloadingFiles = useRef(new Set<string>());

  // 素材库存在服务器上、所有人共用；也处理从官方素材网站跳回来的一键导入
  useHandleLibrary({ excalidrawAPI: api, adapter: libraryAdapter });

  useEffect(() => {
    document.title = boardName ? `${boardName} · 共享白板` : "共享白板";
  }, [boardName]);

  const syncFiles = useCallback(() => {
    if (!api) return;
    const files = api.getFiles();
    for (const el of api.getSceneElements()) {
      if (el.type !== "image" || !el.fileId) continue;
      const fileId = el.fileId;
      const local = files[fileId];
      if (local && !uploadedFiles.current.has(fileId) && !uploadingFiles.current.has(fileId)) {
        uploadingFiles.current.add(fileId);
        uploadFile(boardId, local)
          .then(() => uploadedFiles.current.add(fileId))
          .catch((err) => {
            console.warn("image upload failed, will retry", err);
            window.setTimeout(syncFiles, FILE_RETRY_MS * 3);
          })
          .finally(() => uploadingFiles.current.delete(fileId));
      } else if (!local && !downloadingFiles.current.has(fileId)) {
        // 别人刚贴的图片可能还在上传，拿不到就隔一会儿再试
        downloadingFiles.current.add(fileId);
        downloadFile(boardId, fileId, FILE_MAX_RETRIES, FILE_RETRY_MS)
          .then((file) => {
            if (!file) return;
            uploadedFiles.current.add(fileId);
            api.addFiles([file as BinaryFileData]);
          })
          .finally(() => downloadingFiles.current.delete(fileId));
      }
    }
  }, [api, boardId]);

  const flush = useCallback(() => {
    sendTimer.current = undefined;
    syncFiles();
    const sync = syncRef.current;
    if (!api || !sync) return;
    const changed = api
      .getSceneElementsIncludingDeleted()
      .filter((el) => syncedVersions.current.get(el.id) !== el.version);
    if (changed.length > 0 && sync.send(changed)) {
      for (const el of changed) syncedVersions.current.set(el.id, el.version);
      setPending(0);
    } else {
      setPending(changed.length);
    }
  }, [api, syncFiles]);

  const applyRemote = useCallback(
    (remote: readonly ExcalidrawElement[]) => {
      if (!api) return;
      const merged = reconcileElements(
        api.getSceneElementsIncludingDeleted() as OrderedExcalidrawElement[],
        remote as Parameters<typeof reconcileElements>[1],
        api.getAppState(),
      );
      const byId = new Map(merged.map((el) => [el.id, el]));
      for (const el of remote) {
        if (byId.get(el.id)?.version === el.version) syncedVersions.current.set(el.id, el.version);
      }
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
      syncFiles();
    },
    [api, syncFiles],
  );

  const updateCollaborators = useCallback(() => {
    api?.updateScene({ collaborators: new Map(collaborators.current) });
  }, [api]);

  const animatePointers = useCallback(() => {
    const now = performance.now();
    for (const [id, anim] of pointerAnims.current) {
      const collaborator = collaborators.current.get(id);
      if (!collaborator?.pointer) {
        pointerAnims.current.delete(id);
        continue;
      }
      const dx = anim.to.x - anim.from.x;
      const dy = anim.to.y - anim.from.y;
      // 距离太远（比如对方跳到画布另一头）就直接过去，不要慢慢滑
      const t = Math.hypot(dx, dy) > 3000 ? 1 : Math.min(1, (now - anim.start) / POINTER_THROTTLE_MS);
      collaborators.current.set(id, {
        ...collaborator,
        pointer: { ...collaborator.pointer, x: anim.from.x + dx * t, y: anim.from.y + dy * t },
      });
      if (t >= 1) pointerAnims.current.delete(id);
    }
    updateCollaborators();
    pointerFrame.current = pointerAnims.current.size > 0 ? requestAnimationFrame(animatePointers) : undefined;
  }, [updateCollaborators]);

  /** 有人跟随我时，把我当前的可视范围发出去；范围没变就不发 */
  const sendViewport = useCallback(() => {
    viewportTimer.current = undefined;
    if (!api || followers.current.size === 0) return;
    const [x1, y1, x2, y2] = getVisibleSceneBounds(api.getAppState());
    const bounds: ViewportBounds = [x1, y1, x2, y2].map((v) => Math.round(v)) as ViewportBounds;
    const key = bounds.join(",");
    if (key === lastViewport.current) return;
    lastViewport.current = key;
    syncRef.current?.sendViewport(bounds);
  }, [api]);

  useEffect(() => {
    if (!api) return;
    const sync = new BoardSync(boardId, { cid: clientId, name: getName() }, {
      onInit(elements, name) {
        // 每次（重新）连接都以服务器的完整快照为准，再把本地更新的部分补发上去
        setBoardName(name);
        syncedVersions.current = new Map(elements.map((el) => [el.id, el.version]));
        applyRemote(elements as ExcalidrawElement[]);
        if (api) {
          const repaired = repairSolids(api.getSceneElementsIncludingDeleted());
          if (repaired.length > 0) {
            const byId = new Map(repaired.map((el) => [el.id, el]));
            api.updateScene({
              elements: api.getSceneElementsIncludingDeleted().map((el) => byId.get(el.id) ?? el),
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
        }
        flush();
      },
      onRemoteUpdate(elements) {
        applyRemote(elements as ExcalidrawElement[]);
      },
      onPresence(users) {
        const next = new Map<SocketId, Collaborator>();
        for (const user of users) {
          if (user.cid === clientId) continue;
          const id = user.cid as SocketId;
          next.set(id, { ...collaborators.current.get(id), id: user.cid, socketId: id, username: user.name });
        }
        collaborators.current = next;
        // 谁在跟随我：有新的人开始跟随时，马上把当前视野发过去
        const nextFollowers = new Set(users.filter((u) => u.following === clientId).map((u) => u.cid));
        const gained = [...nextFollowers].some((cid) => !followers.current.has(cid));
        followers.current = nextFollowers;
        if (gained) {
          lastViewport.current = "";
          sendViewport();
        }
        api?.updateScene({
          collaborators: new Map(collaborators.current),
          appState: { followedBy: new Set([...nextFollowers].map((cid) => cid as SocketId)) },
        });
      },
      onPointer(p) {
        if (p.cid === clientId) return;
        const id = p.cid as SocketId;
        const previous = collaborators.current.get(id)?.pointer;
        const target = { x: p.x, y: p.y };
        collaborators.current.set(id, {
          ...collaborators.current.get(id),
          id: p.cid,
          socketId: id,
          username: p.name,
          pointer: { x: previous?.x ?? p.x, y: previous?.y ?? p.y, tool: p.tool },
          button: p.button,
        });
        pointerAnims.current.set(id, { from: previous ?? target, to: target, start: performance.now() });
        if (pointerFrame.current === undefined) pointerFrame.current = requestAnimationFrame(animatePointers);
      },
      onViewport(cid, bounds) {
        if (cid !== following.current || !api) return;
        const { appState } = zoomToFitBounds({ bounds, appState: api.getAppState(), fitToViewport: true, viewportZoomFactor: 1 });
        api.updateScene({ appState: { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom } });
      },
      onBoardName: setBoardName,
      onStatus: setStatus,
    });
    syncRef.current = sync;
    return () => {
      sync.dispose();
      syncRef.current = null;
      window.clearTimeout(sendTimer.current);
      window.clearTimeout(pointerTimer.current);
      window.clearTimeout(viewportTimer.current);
      if (pointerFrame.current !== undefined) cancelAnimationFrame(pointerFrame.current);
      pointerFrame.current = undefined;
    };
  }, [api, boardId, applyRemote, flush, updateCollaborators, animatePointers, sendViewport]);

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, _files: BinaryFiles) => {
      const solid = findSelectedSolid(elements, appState.selectedElementIds);
      setSelectedSolid((prev) =>
        prev?.groupId === solid?.groupId && prev?.members.length === solid?.members.length ? prev : solid,
      );
      if (sendTimer.current === undefined) sendTimer.current = window.setTimeout(flush, SEND_THROTTLE_MS);
      // 点别人头像开始跟随、点「停止跟随」或自己拖动画布（Excalidraw 会自动取消跟随）时通知服务器
      const target = appState.userToFollow?.socketId ?? null;
      if (target !== following.current) {
        following.current = target;
        syncRef.current?.setFollowing(target);
      }
      if (followers.current.size > 0 && viewportTimer.current === undefined) {
        viewportTimer.current = window.setTimeout(sendViewport, VIEWPORT_THROTTLE_MS);
      }
      // 节流而不是防抖：别人的光标动画每帧都会触发 onChange，防抖的话会一直推迟、永远存不上
      latestElements.current = elements;
      if (cacheTimer.current === undefined) {
        cacheTimer.current = window.setTimeout(() => {
          cacheTimer.current = undefined;
          saveCache(boardId, latestElements.current);
        }, CACHE_THROTTLE_MS);
      }
    },
    [boardId, flush, sendViewport],
  );

  const onPointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number; tool: "pointer" | "laser" }; button: "down" | "up" }) => {
      latestPointer.current = { ...payload.pointer, button: payload.button };
      if (pointerTimer.current !== undefined) return;
      pointerTimer.current = window.setTimeout(() => {
        pointerTimer.current = undefined;
        if (latestPointer.current) syncRef.current?.sendPointer(latestPointer.current);
        latestPointer.current = null;
      }, POINTER_THROTTLE_MS);
    },
    [],
  );

  const changeNickname = (name: string) => {
    saveName(name);
    setNickname(name);
    syncRef.current?.setName(name);
    setDialog(null);
  };

  const showToast = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(null), 4000);
  };

  // 恢复备份：快照里的图形以更高的版本号写回，快照里没有的图形标记为删除，
  // 这样会作为一次普通修改同步给所有人，也能用撤销退回去
  const restoreSnapshot = async (snapshot: SnapshotSummary) => {
    setDialog(null);
    if (!api) return;
    try {
      const restored = await getSnapshot<ExcalidrawElement>(boardId, snapshot.id);
      const current = new Map(api.getSceneElementsIncludingDeleted().map((el) => [el.id, el]));
      const restoredIds = new Set(restored.map((el) => el.id));
      const now = Date.now();
      const next: ExcalidrawElement[] = restored.map((el) => ({
        ...el,
        isDeleted: false,
        version: Math.max(el.version, current.get(el.id)?.version ?? 0) + 1,
        versionNonce: randomNonce(),
        updated: now,
      }));
      for (const el of current.values()) {
        if (restoredIds.has(el.id)) continue;
        next.push(
          el.isDeleted ? el : { ...el, isDeleted: true, version: el.version + 1, versionNonce: randomNonce(), updated: now },
        );
      }
      api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      showToast("已恢复。按 Ctrl+Z 可以撤销");
    } catch (err) {
      window.alert(`恢复失败：${(err as Error).message}`);
    }
  };

  // selectedSolid 只用来决定是否显示按钮；真正修改时要从画布重新取，
  // 否则拿到的是上次修改前（或被拉伸前）的旧尺寸和旧位置
  const currentSelectedSolid = () =>
    api ? findSelectedSolid(api.getSceneElements(), api.getAppState().selectedElementIds) : null;

  const openSolidEditor = () => {
    const solid = currentSelectedSolid();
    if (solid) {
      setSolidDialog({ spec: currentSolidSpec(solid), background: styleOf(solid.members).backgroundColor, editing: true });
    }
  };

  const openSolidInserter = () =>
    setSolidDialog({ spec: { type: "cube", ...DEFAULT_SIZE.cube }, background: DEFAULT_SOLID_BACKGROUND, editing: false });

  const insertSolid = (spec: SolidSpec, background: string) => {
    setSolidDialog(null);
    if (!api) return;
    const appState = api.getAppState();
    const editing = solidDialog?.editing ? currentSelectedSolid() : null;
    let elements: ExcalidrawElement[];
    let existing = api.getSceneElementsIncludingDeleted() as ExcalidrawElement[];
    if (editing) {
      // 修改尺寸：在原位置重新生成，保留样式和外层分组，旧的标记为删除
      const [minX, minY] = getCommonBounds(editing.members);
      elements = createSolidElements(
        spec,
        { x: minX, y: minY },
        { ...styleOf(editing.members), backgroundColor: background },
        editing.groupId,
      ).map(
        (el) => ({ ...el, groupIds: editing.members[0].groupIds }),
      );
      const old = new Set(editing.members.map((el) => el.id));
      existing = existing.map((el) =>
        old.has(el.id)
          ? { ...el, isDeleted: true, version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }
          : el,
      );
    } else {
      // 放在当前视野中央，样式沿用当前选中的线条设置，背景用半透明
      const style = {
        strokeColor: appState.currentItemStrokeColor,
        backgroundColor: background,
        fillStyle: "solid" as const,
        strokeWidth: appState.currentItemStrokeWidth,
        roughness: appState.currentItemRoughness,
        opacity: appState.currentItemOpacity,
      };
      const [, , maxX, maxY] = getCommonBounds(createSolidElements(spec, { x: 0, y: 0 }, style));
      const centerX = -appState.scrollX + appState.width / 2 / appState.zoom.value;
      const centerY = -appState.scrollY + appState.height / 2 / appState.zoom.value;
      elements = createSolidElements(spec, { x: centerX - maxX / 2, y: centerY - maxY / 2 }, style);
    }
    const groupId = elements[0].groupIds[0];
    api.updateScene({
      elements: [...existing, ...elements],
      appState: {
        selectedElementIds: Object.fromEntries(elements.map((el) => [el.id, true as const])),
        selectedGroupIds: { [groupId]: true },
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  const changeBoardName = async (name: string) => {
    setDialog(null);
    try {
      const res = await renameBoard(boardId, name);
      setBoardName(res.name);
    } catch (err) {
      window.alert(`重命名失败：${(err as Error).message}`);
    }
  };

  return (
    <div className="board">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        isCollaborating
        langCode="zh-CN"
        renderTopRightUI={() => (
          <StatusBadge
            status={status}
            pending={pending}
            boardName={boardName}
            nickname={nickname}
            onRename={() => setDialog("rename")}
            onEditNickname={() => setDialog("nickname")}
            onInsertSolid={openSolidInserter}
            onEditSolid={
              selectedSolid ? openSolidEditor : undefined
            }
          />
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => location.assign("/")}>所有白板</MainMenu.Item>
          <MainMenu.Item
            onSelect={openSolidInserter}
          >
            插入 3D 体
          </MainMenu.Item>
          <MainMenu.Item onSelect={() => setDialog("history")}>历史版本（自动备份）</MainMenu.Item>
          <MainMenu.Item onSelect={() => setDialog("rename")}>重命名白板</MainMenu.Item>
          <MainMenu.Item onSelect={() => setDialog("nickname")}>修改我的昵称</MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
      {dialog === "nickname" && (
        <NameDialog
          title="修改我的昵称"
          hint="其他人会在你的鼠标旁边看到这个名字。浏览器会记住它，以后进任何白板都用这个名字。"
          initial={nickname}
          onConfirm={changeNickname}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "rename" && (
        <NameDialog
          title="重命名白板"
          initial={boardName}
          onConfirm={changeBoardName}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "history" && (
        <HistoryDialog boardId={boardId} onRestore={restoreSnapshot} onClose={() => setDialog(null)} />
      )}
      {toast && <div className="toast">{toast}</div>}
      {solidDialog && (
        <SolidDialog
          initial={solidDialog.spec}
          initialBackground={solidDialog.background}
          editing={solidDialog.editing}
          onConfirm={insertSolid}
          onCancel={() => setSolidDialog(null)}
        />
      )}
      {status.kind === "deleted" && (
        <div className="overlay">
          <div className="dialog">
            <h2>这块白板已被移到回收站</h2>
            <p>7 天内可以在首页的回收站里恢复。</p>
            <a className="button" href="/">
              去首页
            </a>
          </div>
        </div>
      )}
      {status.kind === "not_found" && (
        <div className="overlay">
          <div className="dialog">
            <h2>找不到这块白板</h2>
            <p>链接可能有误，或者白板已被删除。</p>
            <a className="button" href="/">
              查看所有白板
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
