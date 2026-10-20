import { DurableObject } from "cloudflare:workers";

export interface Env {
  BOARD: DurableObjectNamespace<Board>;
}

// Excalidraw 元素：只关心用于合并的字段，其余原样保存
type Element = { id: string; version: number; versionNonce: number; [key: string]: unknown };

type ClientMessage = { type: "update"; elements: Element[] };

const BOARD_ID = /^[A-Za-z0-9_-]{6,64}$/;
// SQLite 单个值上限 2 MB，留出余量
const MAX_ELEMENT_BYTES = 1_500_000;
const MAX_ELEMENTS_PER_MESSAGE = 5_000;
// 修改先合并在内存里，每隔这么久才写一次 SQLite。拖动一个图形 5 秒只写 1 行，而不是几十行，
// 免费计划每天只有 10 万行写入额度，这是最先会用完的一项
const FLUSH_INTERVAL_MS = 5_000;

function newBoardId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isElement(value: unknown): value is Element {
  const el = value as Element;
  return (
    typeof el === "object" &&
    el !== null &&
    typeof el.id === "string" &&
    el.id.length > 0 &&
    el.id.length <= 128 &&
    Number.isFinite(el.version) &&
    Number.isFinite(el.versionNonce)
  );
}

// 与 Excalidraw 自身的规则一致：版本号高者胜；版本相同时 versionNonce 小者胜
function incomingWins(incoming: Element, stored: Element): boolean {
  if (incoming.version !== stored.version) return incoming.version > stored.version;
  return incoming.versionNonce < stored.versionNonce;
}

/**
 * 每块白板一个 Durable Object：负责 WebSocket 连接、合并修改、写入 SQLite、广播给其他人。
 * 使用可休眠 WebSocket，没人画的时候对象可以休眠，不计算时长。
 */
export class Board extends DurableObject<Env> {
  private sql: SqlStorage;
  // 当前白板的全部元素（含尚未写入 SQLite 的修改），对象被唤醒后首次使用时从 SQLite 加载
  private elements: Map<string, Element> | null = null;
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS elements (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      version_nonce INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    // 心跳由运行时直接回复，不会唤醒对象
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  create(): void {
    this.sql.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?)`, new Date().toISOString());
  }

  private exists(): boolean {
    return this.sql.exec(`SELECT 1 FROM meta WHERE key = 'created_at'`).toArray().length > 0;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    if (!this.exists()) {
      // 浏览器拿不到握手失败的状态码，所以先接受连接，再用消息说明原因
      server.send(JSON.stringify({ type: "error", code: "not_found" }));
      server.close(4404, "board not found");
      return new Response(null, { status: 101, webSocket: client });
    }

    server.send(JSON.stringify({ type: "init", elements: [...this.load().values()] }));
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let message: ClientMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message?.type !== "update" || !Array.isArray(message.elements)) return;

    const elements = this.load();
    const accepted: Element[] = [];
    const rejected: Element[] = [];
    for (const el of message.elements.slice(0, MAX_ELEMENTS_PER_MESSAGE)) {
      if (!isElement(el)) continue;
      const stored = elements.get(el.id);
      if (!stored || incomingWins(el, stored)) {
        if (JSON.stringify(el).length > MAX_ELEMENT_BYTES) continue;
        elements.set(el.id, el);
        this.dirty.add(el.id);
        accepted.push(el);
      } else if (stored.version !== el.version || stored.versionNonce !== el.versionNonce) {
        rejected.push(stored);
      }
    }
    // 有待写入的修改时，定时器会阻止对象休眠，所以内存里的修改不会因休眠丢失
    if (this.dirty.size > 0 && this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }

    if (accepted.length > 0) {
      const payload = JSON.stringify({ type: "update", elements: accepted });
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws) this.safeSend(other, payload);
      }
    }
    // 发送方的版本落后于服务器时，把服务器上的版本发回去，保证各端最终一致
    if (rejected.length > 0) {
      this.safeSend(ws, JSON.stringify({ type: "update", elements: rejected }));
    }
  }

  private load(): Map<string, Element> {
    if (!this.elements) {
      this.elements = new Map(
        this.sql
          .exec<{ data: string }>(`SELECT data FROM elements`)
          .toArray()
          .map((row) => {
            const el = JSON.parse(row.data) as Element;
            return [el.id, el];
          }),
      );
    }
    return this.elements;
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.elements || this.dirty.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    try {
      this.writeElements(ids);
    } catch (err) {
      // 例如超出免费计划当天的写入额度：保留这些修改，稍后再试，在线的人之间仍然正常同步
      console.error("flush failed, will retry", err);
      for (const id of ids) this.dirty.add(id);
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS * 6);
    }
  }

  private writeElements(ids: string[]): void {
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) {
        const el = this.elements!.get(id)!;
        this.sql.exec(
          `INSERT INTO elements (id, version, version_nonce, data) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET version = excluded.version, version_nonce = excluded.version_nonce, data = excluded.data`,
          el.id,
          el.version,
          el.versionNonce,
          JSON.stringify(el),
        );
      }
    });
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // 已经关闭
    }
    this.broadcastPresence(ws);
    if (this.ctx.getWebSockets().every((s) => s === ws || s.readyState !== WebSocket.OPEN)) this.flush();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastPresence(ws);
  }

  private broadcastPresence(leaving?: WebSocket): void {
    const sockets = this.ctx.getWebSockets().filter((s) => s !== leaving && s.readyState === WebSocket.OPEN);
    const payload = JSON.stringify({ type: "presence", count: sockets.length });
    for (const s of sockets) this.safeSend(s, payload);
  }

  private safeSend(ws: WebSocket, payload: string): void {
    try {
      ws.send(payload);
    } catch {
      // 连接已断开，下次重连时会拿到完整数据
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/boards" && request.method === "POST") {
      const id = newBoardId();
      await env.BOARD.get(env.BOARD.idFromName(id)).create();
      return json({ id }, 201);
    }

    const ws = url.pathname.match(/^\/api\/boards\/([^/]+)\/ws$/);
    if (ws) {
      if (!BOARD_ID.test(ws[1])) return json({ error: "invalid board id" }, 400);
      return env.BOARD.get(env.BOARD.idFromName(ws[1])).fetch(request);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
