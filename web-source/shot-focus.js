/* 截取「点课表课程块 → 定位高亮」的验证图 */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9351;
const BASE = "http://127.0.0.1:8123/index.html";
const OUT = path.join(__dirname, "preview");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const JOBS = [
  { file: "08-点击定位-周三.png", q: "?preset=yin&force=1&s=81", eval: `
      document.querySelector('#grid-host .cblock[data-cid="c2"][data-sidx="0"]').click();` },
  { file: "09-点击定位-周一.png", q: "?preset=yin&force=1&s=82", eval: `
      document.querySelector('.mask').classList.remove('on');
      document.querySelector('#grid-host .cblock[data-cid="c2"][data-sidx="1"]').click();` },
  { file: "10-长列表滚动定位.png", q: "?preset=yin&force=1&s=83", eval: `
      var t={id:'__t', name:'临时测试课', teacher:'', location:'', color:'#5B7CFA', sessions:[]};
      for(var i=1;i<=8;i++) t.sessions.push({day:i, start:1, end:1, weeks:'1-20', room:'', parity:0});
      S.courses.push(t); openCourseEditor('__t', 7);` }
];

async function main() {
  const udd = path.join(os.tmpdir(), "edge-shot-" + Date.now());
  const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + udd, "about:blank"], { stdio: "ignore" });
  let ok = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ok = true; break; } } catch (e) {} await sleep(250); }
  if (!ok) throw new Error("端口未就绪");
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find(t => t.type === "page" && t.webSocketDebuggerUrl);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws 失败")); });
  let seq = 0; const pending = new Map();
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  await send("Page.enable"); await send("Runtime.enable");

  for (const j of JOBS) {
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send("Page.navigate", { url: BASE + j.q });
    await sleep(3000);
    const er = await send("Runtime.evaluate", { expression: "(function(){" + j.eval + "})()", returnByValue: true });
    if (er.exceptionDetails) console.log("  ! eval 异常:", JSON.stringify(er.exceptionDetails).slice(0, 200));
    await sleep(900);
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const buf = Buffer.from(r.data, "base64");
    fs.writeFileSync(path.join(OUT, j.file), buf);
    console.log("  " + j.file.padEnd(28) + " 390x844@2x  " + (buf.length / 1024).toFixed(1) + " KB");
  }
  ws.close(); try { proc.kill(); } catch (e) {} await sleep(400);
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  console.log("完成");
}
main().catch(e => { console.error("失败:", e.message); process.exit(1); });
