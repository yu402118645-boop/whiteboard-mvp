# 共享白板 MVP

一个最小可行原型，只验证最关键的技术风险：多人实时协作在真实网络（尤其是中国大陆）下是否稳定。

- 前端：React + [Excalidraw](https://github.com/excalidraw/excalidraw)（MIT 协议，可免费商用）
- 后端：Cloudflare Workers + Durable Objects（SQLite 存储，免费计划可用）
- 每块白板对应一个 Durable Object，负责 WebSocket 连接、合并修改、持久化和广播

## 已实现

1. **新建白板并生成分享链接**：首页点「新建白板」，得到 `/b/<随机ID>` 链接，右上角「复制分享链接」。
2. **多浏览器实时同步**：每个图形带版本号，服务器按「版本高者胜」合并，只广播有变化的图形；绘制过程中的高频变化合并成每 80 ms 最多一条消息，控制免费额度消耗。
3. **关闭后数据仍在**：所有图形存在 Durable Object 的 SQLite 里；浏览器本地也缓存一份。
4. **断线自动重连**：指数退避（0.5 s 起，最长 10 s，带随机抖动）；每 15 s 心跳，40 s 无响应视为假死连接并重连；网络恢复、手机切回前台时立即重连。断线期间的修改保留在本地，重连后自动补发；重连时以服务器完整快照为基准合并。
5. **连接状态提示**：右上角显示「已连接 · N 人在线 · 延迟 X ms」「正在重连」「连接已断开，N 秒后重连」和待同步修改数。延迟数字方便国内测试时记录。

刻意没做：图片上传（图片工具已隐藏）、账号与权限、白板列表、导出。知道链接的人都能编辑。

字体等静态资源全部由自己的域名提供（构建时从 Excalidraw 包复制到 `public/fonts`），不依赖 unpkg / esm.sh 等国外 CDN。

## 本地运行

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev        # 构建前端并启动 wrangler dev，打开 http://localhost:8787
```

本地数据保存在 `.wrangler/state`，重启后仍在。

## 部署到 Cloudflare（需要你自己的账号）

1. 注册 Cloudflare 账号（免费计划即可）。
2. 在项目目录执行：

```bash
npm install
npx wrangler login     # 浏览器里授权
npm run deploy         # 构建并部署
```

部署完成后会输出一个 `https://whiteboard-mvp.<你的子域>.workers.dev` 地址。

### 关于中国大陆访问

`*.workers.dev` 域名在中国大陆经常无法访问或被 DNS 污染，**国内测试请绑定自己的域名**：

1. 把域名托管到 Cloudflare（在 Cloudflare 购买，或把已有域名的 NS 改到 Cloudflare）。
2. 在 `wrangler.jsonc` 里加上：

```jsonc
"routes": [{ "pattern": "board.example.com", "custom_domain": true }]
```

3. 再执行一次 `npm run deploy`。

### 用量与费用

免费计划的额度按天计算，每天 00:00 UTC（北京时间 08:00）重置；超出后相应操作会报错，不会自动扣费。

按「8 人同时在线、连续 14 小时、每人约 15% 的时间在画或拖动」估算一次协作：

| 额度项 | 免费额度/天 | 估算用量 | 说明 |
| --- | --- | --- | --- |
| Durable Objects SQLite 写入行数 | 10 万行 | 约 4.5 万行 | 最先触顶的一项；修改在内存里合并，每 5 秒才写一次库 |
| Durable Objects 请求数 | 10 万 | 约 3 万 | 收到的 WebSocket 消息按 20 条算 1 次请求，发出的消息免费 |
| Durable Objects 时长 | 13,000 GB-s | 最多约 6,300 GB-s | 按 128 MB × 14 小时一直活跃计算的上限 |
| SQLite 读取行数 | 500 万行 | 几千行 | 只在对象唤醒时读一次全部图形 |
| Workers 请求数 | 10 万 | 几百 | 只有建白板和建立 WebSocket 连接算；静态资源不计 |
| 存储 | 5 GB | 每块白板几 MB | |

实测数据（本地，2 人连续操作 20 秒）：服务器收到 427 条同步消息、434 次图形更新，SQLite 只写了 30 行。

如果实际使用更密集，可以调整这两个参数：

- `worker/index.ts` 里的 `FLUSH_INTERVAL_MS`（默认 5 秒）：改成 10 秒，写入行数大约减半。
- `src/Board.tsx` 里的 `SEND_THROTTLE_MS`（默认 80 毫秒）：改成 150 毫秒，请求数大约减半，别人看到的拖动会稍微不那么顺滑。

如果某天写入额度用完，在线的人之间仍能正常同步，服务器会每 30 秒重试写库；第二天额度重置后自动补写。用量可以在 Cloudflare 控制台的 Workers & Pages → whiteboard-mvp → Metrics 查看。如果经常触顶，Workers 付费计划每月 5 美元，包含的额度远高于这个用量。

## 建议的国内测试记录项

在至少两种网络（家庭宽带、手机热点）下记录：

- 网页能否打开、首次加载用时
- 状态栏是否稳定显示「已连接」，延迟大约多少 ms
- 一小时内断线次数，断线后多久恢复，恢复后内容是否一致

## 目录结构

```
worker/index.ts      Worker 入口 + Board Durable Object（同步与存储）
src/sync.ts          WebSocket 连接、心跳、重连
src/Board.tsx        白板页面：合并远端修改、发送本地修改、本地缓存
src/StatusBadge.tsx  连接状态与分享按钮
src/Home.tsx         首页（新建白板）
wrangler.jsonc       Cloudflare 配置
```
