/**
 * 把 ../class-schedule 的网页源码同步到 www/
 *
 * 为什么用白名单：../class-schedule 里还放着验证脚本（e2e-focus.js / shot-focus.js）、
 * 截图（preview/）、图标生成器（make_icons.py）。这些都不该进 APK。
 * 白名单的好处是：以后往源目录加新文件时，不会悄悄被漏掉或误打包。
 *
 * 源目录仍是唯一真源。改完网页只跑 `npm run sync:web` 即可，不要手改 www/。
 */
import { cp, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DST = path.join(HERE, "www");

// 源码位置。两种布局都要支持：
//   本地开发：class-schedule-mobile/ 和 class-schedule/ 是同级目录
//   仓库里  ：源码在 class-schedule-mobile/web-source/ 子目录下
// 优先取同级（本地开发时的真源），找不到就回退到子目录（克隆仓库的场景）。
const CANDIDATES = [
  path.resolve(HERE, "..", "class-schedule"),   // 本地开发
  path.join(HERE, "web-source"),                // 仓库内
];
const SRC = CANDIDATES.find(p => existsSync(p)) || CANDIDATES[0];

// 需要进 APK 的网页资源（相对源目录）
const ALLOW = [
  "index.html",
  "manifest.json",
  "sw.js",
  "preset-yin.json",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png"
];

const fmt = n => (n / 1024).toFixed(1) + " KB";

async function main() {
  if (!existsSync(SRC)) {
    console.error("找不到源目录: " + SRC);
    process.exit(1);
  }

  // 全量重建，避免删掉源文件后 www 里留残骸
  await rm(DST, { recursive: true, force: true });
  await mkdir(DST, { recursive: true });

  const missing = [];
  let total = 0;
  for (const rel of ALLOW) {
    const from = path.join(SRC, rel);
    if (!existsSync(from)) { missing.push(rel); continue; }
    const to = path.join(DST, rel);
    await cp(from, to);
    const s = await stat(to);
    total += s.size;
    console.log("  + " + rel.padEnd(24) + fmt(s.size));
  }

  if (missing.length) {
    console.error("\n缺少这些文件（源目录里没有）: " + missing.join(", "));
    process.exit(1);
  }

  const files = await readdir(DST);
  console.log("\nwww/ 就绪: " + files.length + " 个文件, 共 " + fmt(total));
}

main().catch(e => { console.error("同步失败:", e.message); process.exit(1); });
