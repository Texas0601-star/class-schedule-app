/* 在浏览器里注入 Capacitor 桩，真跑一遍原生代码路径。
   目的：把「原生通知/文件/返回键无法验证」变成可断言。
   桩会把每次插件调用记进 window.__calls，测试结束后逐条核对参数。 */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9361;
const BASE = "http://127.0.0.1:8123/index.html";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const out = [];
const ck = (n, c, e) => {
  if (c) { pass++; out.push("  PASS  " + n); }
  else { fail++; out.push("  FAIL  " + n + "  -> " + JSON.stringify(e)); }
};

// 注入到页面脚本之前
const STUB = `
window.__calls = [];
window.__log = function(ev, arg){ window.__calls.push({ ev: ev, arg: arg }); };
window.Capacitor = {
  isNativePlatform: function(){ return true; },
  getPlatform: function(){ return "android"; },
  Plugins: {
    LocalNotifications: {
      checkPermissions: function(){ window.__log("checkPermissions"); return Promise.resolve({display:"granted"}); },
      requestPermissions: function(){ window.__log("requestPermissions"); return Promise.resolve({display:"granted"}); },
      createChannel: function(o){ window.__log("createChannel", o); return Promise.resolve(); },
      getPending: function(){ return Promise.resolve({notifications: window.__pending || []}); },
      cancel: function(o){ window.__log("cancel", o); return Promise.resolve(); },
      schedule: function(o){ window.__log("schedule", o); return Promise.resolve(); }
    },
    Filesystem: {
      writeFile: function(o){ window.__log("writeFile", {path:o.path, directory:o.directory, dataLen:(o.data||"").length, head:(o.data||"").slice(0,24)});
                             return Promise.resolve({uri:"file:///cache/" + o.path}); }
    },
    Share: { share: function(o){ window.__log("share", o); return Promise.resolve(); } },
    StatusBar: {
      setOverlaysWebView: function(o){ window.__log("setOverlaysWebView", o); return Promise.resolve(); },
      setBackgroundColor: function(o){ window.__log("setBackgroundColor", o); return Promise.resolve(); },
      setStyle: function(o){ window.__log("setStyle", o); return Promise.resolve(); }
    },
    App: {
      addListener: function(ev, cb){ window.__log("addListener", ev); window.__backHandler = cb; return Promise.resolve(); },
      exitApp: function(){ window.__log("exitApp"); window.__exited = true; }
    }
  }
};
`;

async function main() {
  const udd = path.join(os.tmpdir(), "edge-native-" + Date.now());
  const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + udd, "about:blank"], { stdio: "ignore" });
  let ok = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ok = true; break; } } catch (e) {} await sleep(250); }
  if (!ok) throw new Error("DevTools 端口未就绪");
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find(x => x.type === "page" && x.webSocketDebuggerUrl);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws 连接失败")); });
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

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  // 关键：不带任何查询参数，模拟 APK 里的 https://localhost/
  await send("Page.navigate", { url: BASE + "?n=" + Date.now() });
  await sleep(3600);

  // ---- 1. 桩生效 ----
  const a = await ev("return {on:NATIVE.on, plat:NATIVE.platform, preset:NATIVE_DEFAULT_PRESET};", "stub");
  ck("注入桩后 NATIVE.on 为 true", a.on === true, a);
  ck("平台识别为 android", a.plat === "android", a);

  // ---- 2. ★ 无 URL 参数时自动载入预置课表（本轮修的 bug）----
  const b = await ev("return {n:S.courses.length, w:S.settings.totalWeeks, sec:S.settings.sections.length, title:(S.title||''), hasC2:!!S.courses.find(x=>x.id==='c2')};", "preset");
  ck("★ APK 首次启动自动载入预置课表（不是空课表）", b.n === 16, b);
  ck("★ 作息为凯里学院 5 大节", b.sec === 5 && b.w === 20, b);
  ck("★ 课程数据完整（含大学物理1）", b.hasC2 === true, b);

  // ---- 3. 状态栏配置 ----
  const c = await ev("return window.__calls.filter(function(x){return ['setOverlaysWebView','setBackgroundColor','setStyle'].indexOf(x.ev)>=0});", "statusbar");
  const sbNames = c.map(x => x.ev);
  ck("状态栏三件事都调了", sbNames.indexOf("setOverlaysWebView") >= 0 && sbNames.indexOf("setBackgroundColor") >= 0 && sbNames.indexOf("setStyle") >= 0, c);
  const overlay = c.find(x => x.ev === "setOverlaysWebView");
  const style = c.find(x => x.ev === "setStyle");
  ck("状态栏设为不覆盖（overlay:false）", overlay && overlay.arg.overlay === false, overlay);
  ck("状态栏样式为 DARK（浅色图标）", style && style.arg.style === "DARK", style);

  // ---- 4. 返回键注册 ----
  const d = await ev("return {hasHandler: typeof window.__backHandler === 'function', listeners: window.__calls.filter(function(x){return x.ev==='addListener'}).map(function(x){return x.arg})};", "back");
  ck("注册了 backButton 监听", d.hasHandler === true && d.listeners.indexOf("backButton") >= 0, d);

  // ---- 5. ★ 原生通知调度：这是 APK 的核心价值 ----
  const e = await ev(`
    window.__calls = [];
    window.__pending = [{id: 91}, {id: 92}];   // 模拟上次调度留下的待处理闹钟
    S.settings.notifyEnabled = true;
    S.settings.notifyAhead = 15;
    await nativeScheduleNotifications();
    var sc = window.__calls.filter(function(x){return x.ev==='schedule'});
    if(!sc.length) return {noSchedule:true, calls:window.__calls.map(function(x){return x.ev})};
    var list = sc[0].arg.notifications;
    var now = Date.now();
    var start = new Date(2026,7,31);          // 开学日 2026-08-31（周一）
    start.setHours(0,0,0,0);
    var bad = [], ids = {}, dupId = 0, minAt = Infinity, maxAt = -Infinity;
    // 按「课程名 + 星期」分组：同一门课可能有多个课次，单双周是按课次算的，不是按课程
    var byKey = {};
    list.forEach(function(n){
      var at = new Date(n.schedule.at);
      if(at.getTime() <= now) bad.push('过去时间');
      if(ids[n.id]) dupId++; ids[n.id] = 1;
      if(at.getTime() < minAt) minAt = at.getTime();
      if(at.getTime() > maxAt) maxAt = at.getTime();
      var nm = String(n.body).split(' · ')[0];
      var dow = (at.getDay()+6)%7+1;          // 周一=1 … 周日=7
      var wk = Math.floor((new Date(at.getFullYear(),at.getMonth(),at.getDate()) - start)/86400000/7) + 1;
      (byKey[nm + '/' + dow] = byKey[nm + '/' + dow] || []).push(wk);
    });
    // 预设里：思想道德与法治 周二=每周(1-16)、周四=单周(1-15)；数字素养通识课 周四=双周(2-16)
    var oddThu  = byKey['思想道德与法治/4'] || [];
    var weeklyTue = byKey['思想道德与法治/2'] || [];
    var evenThu = byKey['数字素养通识课/4'] || [];
    var uniq = function(a){ return a.filter(function(v,i){return a.indexOf(v)===i}).sort(function(x,y){return x-y}) };
    return {
      count: list.length, badCount: bad.length, dupId: dupId,
      spanDays: Math.round((maxAt-minAt)/86400000),
      firstSample: {title:list[0].title, body:list[0].body, smallIcon:list[0].smallIcon, channelId:list[0].channelId},
      oddThuWeeks: uniq(oddThu),
      oddThuOk: oddThu.length ? oddThu.every(function(w){return w%2===1}) : null,
      weeklyTueWeeks: uniq(weeklyTue),
      evenThuWeeks: uniq(evenThu),
      evenThuOk: evenThu.length ? evenThu.every(function(w){return w%2===0}) : null,
      channel: (window.__calls.filter(function(x){return x.ev==='createChannel'})[0]||{}).arg,
      cancelled: window.__calls.filter(function(x){return x.ev==='cancel'})
    };`, "notify");
  ck("★ 原生通知已注册（不是走 setTimeout）", e.count > 0, e);
  ck("★ 全部是未来时间，无过期条目", e.badCount === 0, e);
  ck("★ 通知 id 无重复", e.dupId === 0, e);
  ck("★ 预排跨度约 4 周（28 天）", e.spanDays >= 25 && e.spanDays <= 29, e);
  ck("★ 通知内容含课程名与时间", e.firstSample && e.firstSample.body.indexOf(" · ") > 0, e.firstSample);
  ck("★ 指定了通知栏小图标 ic_stat_icon", e.firstSample && e.firstSample.smallIcon === "ic_stat_icon", e.firstSample);
  ck("★ 指定了通知渠道 class-reminder", e.channel && e.channel.id === "class-reminder", e.channel);
  ck("★ 单周课（思法·周四）只排奇数周", e.oddThuOk === true, e.oddThuWeeks);
  ck("★ 每周课（思法·周二）不受单双周影响", e.weeklyTueWeeks.length > 0 && e.weeklyTueWeeks.some(w => w % 2 === 0), e.weeklyTueWeeks);
  ck("★ 双周课（数字素养·周四）只排偶数周", e.evenThuOk === true, e.evenThuWeeks);
  ck("★ 重新调度前清空了旧闹钟", e.cancelled.length === 1 && e.cancelled[0].arg.notifications.length === 2, e.cancelled);

  // ---- 6. ★ 导出走原生文件+分享，不再走 <a download> ----
  const f = await ev(`
    window.__calls = [];
    await download("我的课表.ics", "BEGIN:VCALENDAR\\r\\n中文测试\\r\\nEND:VCALENDAR", "text/calendar");
    var wf = window.__calls.filter(function(x){return x.ev==='writeFile'});
    var sh = window.__calls.filter(function(x){return x.ev==='share'});
    return {writeFile: wf.length, share: sh.length, path: wf.length?wf[0].arg.path:null,
            dir: wf.length?wf[0].arg.directory:null, dataLen: wf.length?wf[0].arg.dataLen:0,
            head: wf.length?wf[0].arg.head:null, shareUrl: sh.length?sh[0].arg.url:null};`, "export");
  ck("★ 导出写文件而非 <a download>", f.writeFile === 1, f);
  ck("★ 写入 CACHE 目录", f.dir === "CACHE", f);
  ck("★ 文件名正确", f.path === "我的课表.ics", f);
  ck("★ 内容以 base64 传入（非原始中文）", f.head && !/[\u4e00-\u9fa5]/.test(f.head) && f.dataLen > 0, f);
  ck("★ 调起系统分享", f.share === 1 && String(f.shareUrl).indexOf("file://") === 0, f);

  // ---- 7. ★ 返回键三级行为 ----
  const g = await ev(`
    var r = {};
    // (a) 弹窗打开时 → 关弹窗，不退出
    openCourseEditor("c2");
    r.sheetOpen = document.querySelector('.mask').classList.contains('on');
    window.__backHandler();
    r.sheetClosed = !document.querySelector('.mask').classList.contains('on');
    r.exitedAfterSheet = !!window.__exited;
    // (b) 非课表页 → 回课表页，不退出
    window.__exited = false;
    switchTab('courses');
    r.tabBefore = tab;
    window.__backHandler();
    r.tabAfter = tab;
    r.exitedAfterTab = !!window.__exited;
    // (c) 已在课表页 → 退出应用
    window.__exited = false;
    window.__backHandler();
    r.exitedAtRoot = !!window.__exited;
    return r;`, "backflow");
  ck("★ 返回键：弹窗打开时先关弹窗", g.sheetOpen === true && g.sheetClosed === true && g.exitedAfterSheet === false, g);
  ck("★ 返回键：非课表页时回课表页", g.tabBefore === "courses" && g.tabAfter === "schedule" && g.exitedAfterTab === false, g);
  ck("★ 返回键：已在课表页才退出应用", g.exitedAtRoot === true, g);

  // ---- 8. 不再注册 Service Worker ----
  const h = await ev("return {sw: !!navigator.serviceWorker.controller, regs: 0};", "sw");
  ck("原生环境跳过 Service Worker 注册", h.sw === false, h);

  ck("无运行时异常", errs.length === 0, errs.slice(0, 3));

  console.log(out.join("\n"));
  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败  (共 " + (pass + fail) + ")");

  ws.close(); try { proc.kill(); } catch (e) {} await sleep(400);
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("失败:", e.message); process.exit(2); });
