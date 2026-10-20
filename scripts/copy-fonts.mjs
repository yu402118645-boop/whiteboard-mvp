// 把 Excalidraw 自带字体复制到 public/fonts，由我们自己的域名提供，避免依赖国外 CDN
import { cpSync, existsSync } from "node:fs";

const src = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
if (!existsSync(src)) throw new Error(`找不到 ${src}，请先运行 npm install`);
cpSync(src, "public/fonts", { recursive: true });
console.log("fonts copied to public/fonts");
