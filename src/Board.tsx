import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureUpdateAction, Excalidraw, MainMenu, reconcileElements } from "@excalidraw/excalidraw";
import type {
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { BoardSync, type ConnectionStatus, type RemotePointer } from "./sync";
import { StatusBadge } from "./StatusBadge";
import { NameDialog } from "./NameDialog";
import { clientId, getName, saveName } from "./identity";
import { renameBoard } from "./api";
import { downloadFile, uploadFile } from "./files";

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
const POINTER_THROTTLE_MS = 200;
const CACHE_THROTTLE_MS = 1000;
const FILE_RETRY_MS = 2000;
const FILE_MAX_RETRIES = 15;

type Dialog = "nickname" | "rename" | null;

export function Board({ boardId }: { boardId: string }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "connecting", attempt: 0 });
  const [pending, setPending] = useState(0);
  const [nickname, setNickname] = useState(getName);
  const [boardName, setBoardName] = useState("");
  const [dialog, setDialog] = useState<Dialog>(getName() ? null : "nickname");
  const initialData = useMemo(() => ({ elements: loadCache(boardId), scrollToContent: true }), [boardId]);

  // 服务器已确认拥有的每个元素版本；本地版本与之不同的元素就是待发送的修改
  const syncedVersions = useRef(new Map<string, number>());
  const syncRef = useRef<BoardSync | null>(null);
  const sendTimer = useRef<number | undefined>(undefined);
  const cacheTimer = useRef<number | undefined>(undefined);
  const collaborators = useRef(new Map<SocketId, Collaborator>());
  const pointerTimer = useRef<number | undefined>(undefined);
  const latestPointer = useRef<Omit<RemotePointer, "cid" | "name"> | null>(null);
  // 图片：服务器已有的、正在上传的、正在下载的
  const uploadedFiles = useRef(new Set<string>());
  const uploadingFiles = useRef(new Set<string>());
  const downloadingFiles = useRef(new Set<string>());

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

  // 先有昵称再连接，这样别人看到的光标一开始就带名字
  const hasNickname = nickname !== "";
  useEffect(() => {
    if (!api || !hasNickname) return;
    const sync = new BoardSync(boardId, { cid: clientId, name: getName() }, {
      onInit(elements, name) {
        // 每次（重新）连接都以服务器的完整快照为准，再把本地更新的部分补发上去
        setBoardName(name);
        syncedVersions.current = new Map(elements.map((el) => [el.id, el.version]));
        applyRemote(elements as ExcalidrawElement[]);
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
        updateCollaborators();
      },
      onPointer(p) {
        if (p.cid === clientId) return;
        const id = p.cid as SocketId;
        collaborators.current.set(id, {
          ...collaborators.current.get(id),
          id: p.cid,
          socketId: id,
          username: p.name,
          pointer: { x: p.x, y: p.y, tool: p.tool },
          button: p.button,
        });
        updateCollaborators();
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
    };
  }, [api, boardId, hasNickname, applyRemote, flush, updateCollaborators]);

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], _appState: unknown, _files: BinaryFiles) => {
      if (sendTimer.current === undefined) sendTimer.current = window.setTimeout(flush, SEND_THROTTLE_MS);
      window.clearTimeout(cacheTimer.current);
      cacheTimer.current = window.setTimeout(() => saveCache(boardId, elements), CACHE_THROTTLE_MS);
    },
    [boardId, flush],
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
          />
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => location.assign("/")}>所有白板</MainMenu.Item>
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
          title="你的昵称"
          hint="其他人会在你的鼠标旁边看到这个名字。浏览器会记住它，下次不用再填。"
          initial={nickname}
          onConfirm={changeNickname}
          onCancel={hasNickname ? () => setDialog(null) : undefined}
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
