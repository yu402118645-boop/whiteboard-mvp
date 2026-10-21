// 白板与服务器之间的 WebSocket 连接：心跳、断线检测、指数退避重连

export type ConnectionStatus =
  | { kind: "connecting"; attempt: number }
  | { kind: "connected"; peers: number; latencyMs: number | null }
  | { kind: "offline"; retryAt: number }
  | { kind: "not_found" };

type SyncedElement = { id: string; version: number; versionNonce: number };

export type PresenceUser = { cid: string; name: string };

export type RemotePointer = {
  cid: string;
  name: string;
  x: number;
  y: number;
  tool: "pointer" | "laser";
  button: "up" | "down";
};

type ServerMessage =
  | { type: "init"; name: string; elements: SyncedElement[] }
  | { type: "update"; elements: SyncedElement[] }
  | { type: "presence"; users: PresenceUser[] }
  | ({ type: "pointer" } & RemotePointer)
  | { type: "meta"; name: string }
  | { type: "error"; code: string };

export interface SyncHandlers {
  onInit(elements: SyncedElement[], boardName: string): void;
  onRemoteUpdate(elements: SyncedElement[]): void;
  onPresence(users: PresenceUser[]): void;
  onPointer(pointer: RemotePointer): void;
  onBoardName(name: string): void;
  onStatus(status: ConnectionStatus): void;
}

const HEARTBEAT_MS = 15_000;
// 超过这么久没收到任何消息（包括心跳回复），就认为连接已经“假死”
const DEAD_AFTER_MS = 40_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 10_000;

export class BoardSync {
  private ws: WebSocket | null = null;
  private ready = false;
  private stopped = false;
  private notFound = false;
  private attempt = 0;
  private peers = 1;
  private latencyMs: number | null = null;
  private pingSentAt = 0;
  private lastMessageAt = 0;
  private retryTimer: number | undefined;
  private heartbeatTimer: number | undefined;
  private connectTimer: number | undefined;

  constructor(
    private boardId: string,
    private identity: { cid: string; name: string },
    private handlers: SyncHandlers,
  ) {
    window.addEventListener("online", this.reconnectNow);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.connect();
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** 发送本地修改；未连接时返回 false，调用方保留这些修改，重连后再发 */
  send(elements: SyncedElement[]): boolean {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "update", elements }));
    return true;
  }

  sendPointer(pointer: Omit<RemotePointer, "cid" | "name">): void {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "pointer", ...pointer }));
  }

  setName(name: string): void {
    this.identity = { ...this.identity, name };
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "profile", name }));
    }
  }

  dispose(): void {
    this.stopped = true;
    window.removeEventListener("online", this.reconnectNow);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.clearTimers();
    this.ws?.close(1000, "leaving");
  }

  private connect(): void {
    this.clearTimers();
    this.ready = false;
    this.handlers.onStatus({ kind: "connecting", attempt: this.attempt });

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const query = new URLSearchParams({ cid: this.identity.cid, name: this.identity.name });
    const ws = new WebSocket(
      `${protocol}//${location.host}/api/boards/${encodeURIComponent(this.boardId)}/ws?${query}`,
    );
    this.ws = ws;

    this.connectTimer = window.setTimeout(() => ws.close(), CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      window.clearTimeout(this.connectTimer);
      this.lastMessageAt = Date.now();
      this.heartbeatTimer = window.setInterval(this.heartbeat, HEARTBEAT_MS);
      this.ping();
    };

    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      this.lastMessageAt = Date.now();
      if (event.data === "pong") {
        this.latencyMs = Date.now() - this.pingSentAt;
        if (this.ready) this.emitConnected();
        return;
      }
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (message.type) {
        case "init":
          this.ready = true;
          this.attempt = 0;
          this.handlers.onInit(message.elements, message.name);
          this.emitConnected();
          break;
        case "update":
          this.handlers.onRemoteUpdate(message.elements);
          break;
        case "presence":
          this.peers = message.users.length;
          this.handlers.onPresence(message.users);
          if (this.ready) this.emitConnected();
          break;
        case "pointer":
          this.handlers.onPointer(message);
          break;
        case "meta":
          this.handlers.onBoardName(message.name);
          break;
        case "error":
          if (message.code === "not_found") {
            this.notFound = true;
            this.handlers.onStatus({ kind: "not_found" });
          }
          break;
      }
    };

    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ready = false;
      this.clearTimers();
      if (this.stopped || this.notFound) return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    // 0.5s, 1s, 2s, 4s, 8s, 10s...，加随机抖动，避免所有人同时重连
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.attempt += 1;
    this.handlers.onStatus({ kind: "offline", retryAt: Date.now() + delay });
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private reconnectNow = (): void => {
    if (this.stopped || this.notFound) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.attempt = 0;
    this.connect();
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") return;
    // 手机切回前台时，连接可能已经被系统掐断但还没触发 close
    if (this.ws?.readyState === WebSocket.OPEN) this.heartbeat();
    else this.reconnectNow();
  };

  private heartbeat = (): void => {
    if (Date.now() - this.lastMessageAt > DEAD_AFTER_MS) {
      this.ws?.close();
      // 有些网络下 close 事件迟迟不来，直接按断线处理
      const dead = this.ws;
      this.ws = null;
      if (dead) dead.onclose = null;
      this.ready = false;
      this.clearTimers();
      if (!this.stopped) this.scheduleReconnect();
      return;
    }
    this.ping();
  };

  private ping(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.pingSentAt = Date.now();
    this.ws.send("ping");
  }

  private emitConnected(): void {
    this.handlers.onStatus({ kind: "connected", peers: this.peers, latencyMs: this.latencyMs });
  }

  private clearTimers(): void {
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.connectTimer);
    window.clearInterval(this.heartbeatTimer);
  }
}
