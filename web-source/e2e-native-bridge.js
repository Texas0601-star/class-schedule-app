/* 校验原生桥接层：浏览器里必须完全惰性，导出逻辑不能被改坏 */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9357;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const out = [];
const ck = (n, c, e) => { if (c) { pass++; out.push("  PASS  " + n); } else { fail++; out.push("  FAIL  " + n + "  -> " + JSON.stringify(e)); } };

async function main() {
  const udd = path.join(os.tmpdir(), "edge-nb-" + Date.now());
  const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + udd, "about:blank"], { stdio: "ignore" });
  let ok = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ok = true; break; } } catch (e) {} await sleep(250); }
  if (!ok) throw new Error("端口未就绪");
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find(x => x.type === "page" && x.webSocketDebuggerUrl);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let seq = 0; const pend = new Map(); const errs = [];
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch (x) { return; }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      errs.push(((d.exception || {}).description || d.text || "").split("\n")[0]);
    }
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const send = (me, pa) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: me, params: pa || {} })); });
  const ev = async (expr, label) => {
    const r = await send("Runtime.evaluate", { expression: "(async function(){" + expr + "})()", returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error("[" + label + "] " + String((d.exception && d.exception.description) || d.text).split("\n")[0]);
    }
    return r.result.value;
  };

  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: "http://127.0.0.1:8123/index.html?preset=yin&force=1&nb=1" });
  await sleep(3200);

  const a = await ev("return {on:NATIVE.on, plat:NATIVE.platform, plugin:nativePlugin('LocalNotifications'), fs:nativePlugin('Filesystem')};", "bridge");
  ck("浏览器里 NATIVE.on 为 false（原生分支不生效）", a.on === false, a);
  ck("浏览器里取不到原生插件", a.plugin === null && a.fs === null, a);

  // btoa 只吃 Latin1，中文会抛 InvalidCharacterError —— 这正是 b64OfUtf8 存在的理由
  const b = await ev("return {b64: b64OfUtf8('我的课表·测试'), rawBtoaThrows: (function(){ try{ btoa('我的课表·测试'); return false; }catch(e){ return true; } })()};", "b64");
  ck("b64OfUtf8 输出正确的 UTF-8 base64", b.b64 === "5oiR55qE6K++6KGowrfmtYvor5U=", b);
  ck("裸 btoa 处理中文确实会抛异常（helper 有必要）", b.rawBtoaThrows === true, b);

  const c = await ev(`
    var ics = buildICS();
    return {
      hasHeader: ics.indexOf("BEGIN:VCALENDAR")===0,
      hasFooter: ics.slice(-15).indexOf("END:VCALENDAR")>=0,
      events: (ics.match(/BEGIN:VEVENT/g)||[]).length,
      dtstart0820: ics.indexOf("DTSTART;TZID=Asia/Shanghai:2026")>=0,
      crlf: ics.indexOf("\\r\\n") > 0,
      rrule: (ics.match(/RRULE:FREQ=WEEKLY/g)||[]).length
    };`, "ics");
  ck("ICS 结构完整（头/尾/事件）", c.hasHeader && c.hasFooter && c.events > 0, c);
  ck("ICS 使用 CRLF 换行", c.crlf === true, c);
  ck("ICS 含每周重复规则", c.rrule > 0, c);

  const d = await ev("return typeof download + '|' + (download.constructor.name);", "dl");
  ck("download 已改为异步函数", d.indexOf("AsyncFunction") >= 0, d);

  const e = await ev(`
    var LN = nativePlugin("LocalNotifications");
    var ok = await nativeScheduleNotifications();
    return {plugin:LN, ret:ok, timers:notifTimers.length};`, "sched");
  ck("原生调度在浏览器里安全返回 false", e.ret === false, e);

  const f = await ev(`
    var saved=null;
    var orig=document.createElement.bind(document);
    document.createElement=function(t){ var el=orig(t); if(t==='a'){ el.click=function(){ saved=el.download; }; } return el; };
    await download("测试.ics","BEGIN:VCALENDAR","text/calendar");
    document.createElement=orig;
    return {name:saved};`, "dlpath");
  ck("浏览器导出仍走 <a download> 老路径", f.name === "测试.ics", f);

  ck("无运行时异常", errs.length === 0, errs.slice(0, 3));

  console.log(out.join("\n"));
  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败  (共 " + (pass + fail) + ")");
  ws.close(); try { proc.kill(); } catch (e) {} await sleep(400);
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("失败:", e.message); process.exit(2); });
