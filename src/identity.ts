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

const ADJECTIVES = ["开心的", "认真的", "安静的", "勇敢的", "好奇的", "淡定的", "机智的", "温柔的", "活泼的", "神秘的", "努力的", "快乐的", "悠闲的", "聪明的", "热情的", "害羞的", "优雅的", "灵感满满的", "睡不醒的", "爱画画的"];
const ANIMALS = ["🐼 熊猫", "🦊 狐狸", "🐱 猫咪", "🐶 小狗", "🐰 兔子", "🐨 考拉", "🐯 老虎", "🦁 狮子", "🐸 青蛙", "🐧 企鹅", "🦉 猫头鹰", "🐳 鲸鱼", "🦄 独角兽", "🐢 乌龟", "🐿️ 松鼠", "🦒 长颈鹿", "🐻 小熊", "🐹 仓鼠", "🦔 刺猬", "🐬 海豚", "🦜 鹦鹉", "🐙 章鱼", "🦥 树懒", "🦦 水獭", "🐝 蜜蜂", "🦋 蝴蝶", "🐘 大象", "🦘 袋鼠", "🐑 小羊", "🦩 火烈鸟"];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

// 默认随机起一个「形容词 + 动物」的昵称，组合有 600 种，多人同时在线也不容易撞名
function randomName(): string {
  const [emoji, animal] = pick(ANIMALS).split(" ");
  return `${emoji} ${pick(ADJECTIVES)}${animal}`;
}

export function getName(): string {
  let name = read(NAME_KEY);
  if (!name) {
    name = randomName();
    write(NAME_KEY, name);
  }
  return name;
}

export function saveName(name: string): void {
  write(NAME_KEY, name);
}
