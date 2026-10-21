import { DurableObject } from "cloudflare:workers";

export interface Env {
  BOARD: DurableObjectNamespace<Board>;
  DIRECTORY: DurableObjectNamespace<Directory>;
}

// Excalidraw 元素：只关心用于合并的字段，其余原样保存
type Element = { id: string; version: number; versionNonce: number; [key: string]: unknown };

type ClientMessage =
  | { type: "update"; elements: Element[] }
  | { type: "pointer"; x: number; y: number; tool: string; button: string }
  | { type: "profile"; name: string };

// 每个连接附带的身份信息，休眠后也能恢复
type Attachment = { cid: string; name: string };

export type BoardSummary = { id: string; name: string; createdAt: string; lastOpenedAt: string | null };

const BOARD_ID = /^[A-Za-z0-9_-]{6,64}$/;
const FILE_ID = /^[A-Za-z0-9_-]{8,128}$/;
// SQLite 单个值上限 2 MB，留出余量
const MAX_ELEMENT_BYTES = 1_500_000;
const MAX_FILE_BYTES = 1_900_000;
const MAX_ELEMENTS_PER_MESSAGE = 5_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp", "image/avif"]);
// 修改先合并在内存里，每隔这么久才写一次 SQLite。拖动一个图形 5 秒只写 1 行，而不是几十行，
// 免费计划每天只有 10 万行写入额度，这是最先会用完的一项
const FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_BOARD_NAME = "未命名白板";

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

function cleanName(value: unknown, fallback: string, max = 60): string {
  const name = typeof value === "string" ? value.trim().slice(0, max) : "";
  return name || fallback;
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
    this.ensureSchema();
    // 心跳由运行时直接回复，不会唤醒对象
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS elements (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      version_nonce INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    // 图片直接存在白板自己的 SQLite 里，不需要开通 R2
    this.sql.exec(`CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }

  create(boardId: string, name: string): void {
    const now = new Date().toISOString();
    this.sql.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?)`, now);
    this.setMeta("board_id", boardId);
    this.setMeta("name", name);
  }

  rename(name: string): void {
    if (!this.exists()) return;
    this.setMeta("name", name);
    this.broadcast(JSON.stringify({ type: "meta", name }));
  }

  /** 删除白板：断开所有人，清空存储 */
  async destroy(): Promise<void> {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.dirty.clear();
    this.elements = null;
    for (const ws of this.ctx.getWebSockets()) {
      this.safeSend(ws, JSON.stringify({ type: "error", code: "not_found" }));
      try {
        ws.close(4404, "board deleted");
      } catch {
        // 已经关闭
      }
    }
    await this.ctx.storage.deleteAll();
    this.ensureSchema();
  }

  putFile(fileId: string, mimeType: string, data: ArrayBuffer): boolean {
    if (!this.exists()) return false;
    this.sql.exec(
      `INSERT OR IGNORE INTO files (id, mime_type, data, created_at) VALUES (?, ?, ?, ?)`,
      fileId,
      mimeType,
      data,
      new Date().toISOString(),
    );
    return true;
  }

  getFile(fileId: string): { mimeType: string; data: ArrayBuffer } | null {
    const row = this.sql
      .exec<{ mime_type: string; data: ArrayBuffer }>(`SELECT mime_type, data FROM files WHERE id = ?`, fileId)
      .toArray()[0];
    return row ? { mimeType: row.mime_type, data: row.data } : null;
  }

  private getMeta(key: string): string | null {
    return this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private exists(): boolean {
    return this.getMeta("created_at") !== null;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const url = new URL(request.url);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    if (!this.exists()) {
      // 浏览器拿不到握手失败的状态码，所以先接受连接，再用消息说明原因
      server.send(JSON.stringify({ type: "error", code: "not_found" }));
      server.close(4404, "board not found");
      return new Response(null, { status: 101, webSocket: client });
    }

    const attachment: Attachment = {
      cid: cleanName(url.searchParams.get("cid"), crypto.randomUUID(), 64),
      name: cleanName(url.searchParams.get("name"), "匿名", 24),
    };
    server.serializeAttachment(attachment);

    const boardId = this.getMeta("board_id") ?? url.searchParams.get("board") ?? "";
    if (!this.getMeta("board_id") && BOARD_ID.test(boardId)) this.setMeta("board_id", boardId);
    const name = this.getMeta("name") ?? DEFAULT_BOARD_NAME;
    server.send(JSON.stringify({ type: "init", name, elements: [...this.load().values()] }));
    this.broadcastPresence();

    // 更新白板列表里的“最近打开时间”；旧版本建的白板也会借此出现在列表里
    if (BOARD_ID.test(boardId)) {
      const createdAt = this.getMeta("created_at")!;
      this.ctx.waitUntil(directory(this.env).touch(boardId, name, createdAt).catch(() => {}));
    }
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
    switch (message?.type) {
      case "update":
        if (Array.isArray(message.elements)) this.handleUpdate(ws, message.elements);
        break;
      case "pointer":
        this.handlePointer(ws, message);
        break;
      case "profile": {
        const attachment = ws.deserializeAttachment() as Attachment;
        ws.serializeAttachment({ ...attachment, name: cleanName(message.name, "匿名", 24) });
        this.broadcastPresence();
        break;
      }
    }
  }

  private handleUpdate(ws: WebSocket, incoming: Element[]): void {
    const elements = this.load();
    const accepted: Element[] = [];
    const rejected: Element[] = [];
    for (const el of incoming.slice(0, MAX_ELEMENTS_PER_MESSAGE)) {
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
      this.broadcast(JSON.stringify({ type: "update", elements: accepted }), ws);
    }
    // 发送方的版本落后于服务器时，把服务器上的版本发回去，保证各端最终一致
    if (rejected.length > 0) {
      this.safeSend(ws, JSON.stringify({ type: "update", elements: rejected }));
    }
  }

  // 鼠标位置只转发、不存储，不消耗写入额度
  private handlePointer(ws: WebSocket, message: Extract<ClientMessage, { type: "pointer" }>): void {
    if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) return;
    const { cid, name } = ws.deserializeAttachment() as Attachment;
    this.broadcast(
      JSON.stringify({
        type: "pointer",
        cid,
        name,
        x: message.x,
        y: message.y,
        tool: message.tool === "laser" ? "laser" : "pointer",
        button: message.button === "down" ? "down" : "up",
      }),
      ws,
    );
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
    if (this.openSockets(ws).length === 0) this.flush();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastPresence(ws);
  }

  private openSockets(leaving?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((s) => s !== leaving && s.readyState === WebSocket.OPEN);
  }

  private broadcastPresence(leaving?: WebSocket): void {
    const users = this.openSockets(leaving).map((s) => s.deserializeAttachment() as Attachment | null);
    const payload = JSON.stringify({
      type: "presence",
      users: users.filter((u): u is Attachment => u !== null).map((u) => ({ cid: u.cid, name: u.name })),
    });
    this.broadcast(payload, leaving);
  }

  private broadcast(payload: string, except?: WebSocket): void {
    for (const s of this.ctx.getWebSockets()) {
      if (s !== except) this.safeSend(s, payload);
    }
  }

  private safeSend(ws: WebSocket, payload: string): void {
    try {
      ws.send(payload);
    } catch {
      // 连接已断开，下次重连时会拿到完整数据
    }
  }
}

/** 全站唯一的白板目录：记录有哪些白板、名字和最近打开时间 */
export class Directory extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_opened_at TEXT
    )`);
  }

  list(): BoardSummary[] {
    return this.sql
      .exec<{ id: string; name: string; created_at: string; last_opened_at: string | null }>(
        `SELECT id, name, created_at, last_opened_at FROM boards ORDER BY COALESCE(last_opened_at, created_at) DESC`,
      )
      .toArray()
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastOpenedAt: r.last_opened_at }));
  }

  add(id: string, name: string, createdAt: string): void {
    this.sql.exec(`INSERT OR IGNORE INTO boards (id, name, created_at) VALUES (?, ?, ?)`, id, name, createdAt);
  }

  rename(id: string, name: string): void {
    this.sql.exec(`UPDATE boards SET name = ? WHERE id = ?`, name, id);
  }

  touch(id: string, name: string, createdAt: string): void {
    this.sql.exec(
      `INSERT INTO boards (id, name, created_at, last_opened_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_opened_at = excluded.last_opened_at`,
      id,
      name,
      createdAt,
      new Date().toISOString(),
    );
  }

  remove(id: string): void {
    this.sql.exec(`DELETE FROM boards WHERE id = ?`, id);
  }
}

function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
}

function board(env: Env, id: string) {
  return env.BOARD.get(env.BOARD.idFromName(id));
}

async function readName(request: Request): Promise<string> {
  try {
    const body = (await request.json()) as { name?: unknown };
    return cleanName(body.name, DEFAULT_BOARD_NAME);
  } catch {
    return DEFAULT_BOARD_NAME;
  }
}

async function handleFile(request: Request, env: Env, ctx: ExecutionContext, boardId: string, fileId: string) {
  if (request.method === "PUT") {
    const mimeType = (request.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!IMAGE_TYPES.has(mimeType)) return json({ error: "unsupported file type" }, 415);
    const data = await request.arrayBuffer();
    if (data.byteLength === 0 || data.byteLength > MAX_FILE_BYTES) return json({ error: "file too large" }, 413);
    const ok = await board(env, boardId).putFile(fileId, mimeType, data);
    return ok ? json({ ok: true }) : json({ error: "board not found" }, 404);
  }

  if (request.method === "GET") {
    // 图片内容不会变（文件 ID 由内容决定），先查 Cloudflare 边缘缓存，减少对白板对象的请求
    const cache = (caches as unknown as { default: Cache }).default;
    const cached = await cache.match(request);
    if (cached) return cached;
    const file = await board(env, boardId).getFile(fileId);
    if (!file) return json({ error: "file not found" }, 404);
    const response = new Response(file.data, {
      headers: {
        "content-type": file.mimeType,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
    ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  }

  return json({ error: "method not allowed" }, 405);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/boards") {
      if (request.method === "GET") return json(await directory(env).list());
      if (request.method === "POST") {
        const id = newBoardId();
        const name = await readName(request);
        await board(env, id).create(id, name);
        await directory(env).add(id, name, new Date().toISOString());
        return json({ id, name }, 201);
      }
      return json({ error: "method not allowed" }, 405);
    }

    const match = path.match(/^\/api\/boards\/([^/]+)(\/.*)?$/);
    if (!match) return json({ error: "not found" }, 404);
    const [, id, rest = ""] = match;
    if (!BOARD_ID.test(id)) return json({ error: "invalid board id" }, 400);

    if (rest === "") {
      if (request.method === "PATCH") {
        const name = await readName(request);
        await board(env, id).rename(name);
        await directory(env).rename(id, name);
        return json({ id, name });
      }
      if (request.method === "DELETE") {
        await board(env, id).destroy();
        await directory(env).remove(id);
        return json({ ok: true });
      }
      return json({ error: "method not allowed" }, 405);
    }

    if (rest === "/ws") {
      // 把白板 ID 带给对象，让它能更新目录
      const forward = new URL(request.url);
      forward.searchParams.set("board", id);
      return board(env, id).fetch(new Request(forward, request));
    }

    const file = rest.match(/^\/files\/([^/]+)$/);
    if (file) {
      if (!FILE_ID.test(file[1])) return json({ error: "invalid file id" }, 400);
      return handleFile(request, env, ctx, id, file[1]);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
