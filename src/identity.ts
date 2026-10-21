// 用户身份保存在浏览器本地（类似 cookie），下次进入不用重新设置昵称

const CID_KEY = "whiteboard:cid";
const NAME_KEY = "whiteboard:name";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式等情况下存不了，只在本次会话有效
  }
}

let cid = read(CID_KEY);
if (!cid) {
  cid = crypto.randomUUID();
  write(CID_KEY, cid);
}

export const clientId: string = cid;

export function getName(): string {
  return read(NAME_KEY) ?? "";
}

export function saveName(name: string): void {
  write(NAME_KEY, name);
}
