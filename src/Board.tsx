import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureUpdateAction, Excalidraw, reconcileElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { BoardSync, type ConnectionStatus } from "./sync";
import { StatusBadge } from "./StatusBadge";

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
const CACHE_THROTTLE_MS = 1000;

export function Board({ boardId }: { boardId: string }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "connecting", attempt: 0 });
  const [pending, setPending] = useState(0);
  const initialData = useMemo(() => ({ elements: loadCache(boardId), scrollToContent: true }), [boardId]);

  // 服务器已确认拥有的每个元素版本；本地版本与之不同的元素就是待发送的修改
  const syncedVersions = useRef(new Map<string, number>());
  const syncRef = useRef<BoardSync | null>(null);
  const sendTimer = useRef<number | undefined>(undefined);
  const cacheTimer = useRef<number | undefined>(undefined);

  const flush = useCallback(() => {
    sendTimer.current = undefined;
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
  }, [api]);

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
    },
    [api],
  );

  useEffect(() => {
    if (!api) return;
    const sync = new BoardSync(boardId, {
      onInit(elements) {
        // 每次（重新）连接都以服务器的完整快照为准，再把本地更新的部分补发上去
        syncedVersions.current = new Map(elements.map((el) => [el.id, el.version]));
        applyRemote(elements as ExcalidrawElement[]);
        flush();
      },
      onRemoteUpdate(elements) {
        applyRemote(elements as ExcalidrawElement[]);
      },
      onStatus: setStatus,
    });
    syncRef.current = sync;
    return () => {
      sync.dispose();
      syncRef.current = null;
      window.clearTimeout(sendTimer.current);
    };
  }, [api, boardId, applyRemote, flush]);

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[]) => {
      if (sendTimer.current === undefined) sendTimer.current = window.setTimeout(flush, SEND_THROTTLE_MS);
      window.clearTimeout(cacheTimer.current);
      cacheTimer.current = window.setTimeout(() => saveCache(boardId, elements), CACHE_THROTTLE_MS);
    },
    [boardId, flush],
  );

  return (
    <div className="board">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={onChange}
        langCode="zh-CN"
        // 第一版不做图片上传：图片文件不同步
        UIOptions={{ tools: { image: false } }}
        renderTopRightUI={() => <StatusBadge status={status} pending={pending} />}
      />
      {status.kind === "not_found" && (
        <div className="overlay">
          <div className="dialog">
            <h2>找不到这块白板</h2>
            <p>链接可能有误，或者白板还没有创建。</p>
            <a className="button" href="/">
              新建一块白板
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
