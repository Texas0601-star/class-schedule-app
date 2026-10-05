/* E2E: 验证「点课表课程块 → 课程编辑器定位高亮对应课次」 */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9347;
const BASE = "http://127.0.0.1:8123/index.html";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const results = [];
function ck(name, cond, extra) {
  if (cond) { pass++; results.push("  PASS  " + name); }
  else { fail++; results.push("  FAIL  " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

async function main() {
  const udd = path.join(os.tmpdir(), "edge-focus-" + Date.now());
  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + udd, "about:blank"
  ], { stdio: "ignore" });

  let ok = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ok = true; break; } } catch (e) {}
    await sleep(250);
  }
  if (!ok) throw new Error("DevTools 端口未就绪");

  let target = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find(t => t.type === "page" && t.webSocketDebuggerUrl);
    if (target) break;
    await sleep(250);
  }
  if (!target) throw new Error("未找到 page target");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws 连接失败")); });
  let seq = 0; const pending = new Map(); const pageErrors = [];
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch (x) { return; }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      pageErrors.push(((d.exception || {}).description || d.text || "").split("\n")[0]);
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const ev = async (expr, label) => {
    const r = await send("Runtime.evaluate", { expression: "(function(){" + expr + "})()", returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error("[步骤 " + (label || "?") + "] " + String(desc).split("\n")[0] + "  @line " + d.lineNumber + ":" + d.columnNumber);
    }
    return r.result.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: BASE + "?preset=yin&force=1&e2e=1" });
  await sleep(3200);

  // ---- 前置 ----
  const boot = await ev("return {n:S.courses.length, w:S.settings.totalWeeks, sec:S.settings.sections.map(x=>x.label+':'+x.start+'-'+x.end)};", "boot");
  ck("载入预设：16 门课 / 20 周", boot.n === 16 && boot.w === 20, boot);
  ck("作息为凯里学院 5 大节", boot.sec.length === 5 && boot.sec[0] === "1-2:08:20-09:55", boot.sec);

  const c2 = await ev("var c=S.courses.find(x=>x.id==='c2'); return {name:c.name, order:c.sessions.map(s=>s.day)};", "c2order");
  ck("c2 课次顺序非天然（周三在前、周一在后）", c2.order[0] === 3 && c2.order[1] === 1, c2);

  // ---- T1：点「周三」块（sidx=0）→ 高亮的必须是周三那条 ----
  const t1 = await ev(`
    document.querySelector('.mask').classList.remove('on');
    var blk=document.querySelector('#grid-host .cblock[data-cid="c2"][data-sidx="0"]');
    if(!blk) return {noBlock:true};
    blk.click();
    var f=document.querySelector('#ce-bd .sess-item.focus');
    return {
      open: document.querySelector('.mask').classList.contains('on'),
      hasFocus: !!f,
      focusIdx: f?f.dataset.esess:null,
      focusIc: f?f.querySelector('.ic').textContent.replace(/\\s+/g,''):null,
      badge: f?!!f.querySelector('.fbadge'):false,
      focusCount: document.querySelectorAll('#ce-bd .sess-item.focus').length,
      title: (document.querySelector('.sheet-hd h3')||{}).textContent
    };`, "T1");
  ck("T1 点周三块后编辑器已打开", t1.open === true, t1);
  ck("T1 标题为「编辑课程」", t1.title === "编辑课程", t1);
  ck("T1 有且仅有一个高亮条目", t1.focusCount === 1, t1);
  ck("T1 高亮的是 data-esess=0（真实索引）", t1.focusIdx === "0", t1);
  ck("T1 高亮条目显示「周三」而不是「周一」", t1.focusIc === "周三1-2", t1);
  ck("T1 高亮条目带「你点的这节」标记", t1.badge === true, t1);

  // ---- T2：关闭后点「周一」块（sidx=1）→ 高亮切到周一 ----
  const t2 = await ev(`
    document.querySelector('.mask').classList.remove('on');
    var blk=document.querySelector('#grid-host .cblock[data-cid="c2"][data-sidx="1"]');
    if(!blk) return {noBlock:true};
    blk.click();
    var f=document.querySelector('#ce-bd .sess-item.focus');
    return {focusIdx:f?f.dataset.esess:null, focusIc:f?f.querySelector('.ic').textContent.replace(/\\s+/g,''):null};
  `, "T2");
  ck("T2 点周一块 → 高亮切到 data-esess=1", t2.focusIdx === "1", t2);
  ck("T2 高亮条目显示「周一」", t2.focusIc === "周一3-4", t2);

  // ---- T3：高亮只出现一次——点高亮条目进课次编辑，取消后不应残留 ----
  const t3 = await ev(`
    var f=document.querySelector('#ce-bd .sess-item.focus');
    f.click();
    var h=(document.querySelector('.sheet-hd h3')||{}).textContent;
    document.querySelector('.sheet-hd .x').click();
    return {opened:h, focusAfter:document.querySelectorAll('#ce-bd .sess-item.focus').length};
  `, "T3");
  ck("T3 点高亮条目进入课次编辑", t3.opened === "编辑课次", t3);
  ck("T3 取消返回后高亮已清除（只高亮一次）", t3.focusAfter === 0, t3);

  // ---- T4：不带 focus 进入（课程页「编辑」）不应有高亮 ----
  const t4 = await ev(`
    document.querySelector('.mask').classList.remove('on');
    location.hash='#courses'; window.dispatchEvent(new HashChangeEvent('hashchange'));
    var b=document.querySelector('#courses-host [data-edit="c2"]');
    if(!b) return {noBtn:true};
    b.click();
    return {focusCount:document.querySelectorAll('#ce-bd .sess-item.focus').length,
            badge:document.querySelectorAll('#ce-bd .fbadge').length};
  `, "T4");
  ck("T4 课程页「编辑」进入无高亮", t4.focusCount === 0 && t4.badge === 0, t4);

  // ---- T5：课程页点课次条目 → 进课次编辑（回归）----
  const t5 = await ev(`
    document.querySelector('.mask').classList.remove('on');
    var row=document.querySelector('#courses-host [data-esess^="c2:"]');
    if(!row) return {noRow:true};
    var key=row.dataset.esess;
    row.click();
    var h=(document.querySelector('.sheet-hd h3')||{}).textContent;
    document.querySelector('.sheet-hd .x').click();
    return {key:key, opened:h};
  `, "T5");
  ck("T5 课程页点课次正常打开课次编辑器", t5.opened === "编辑课次", t5);

  // ---- T6：今日页点课程条目 → 定位高亮 ----
  // 今天是周日、预设课表周日无课，先注入一条「今天」的临时课程再测
  const t6 = await ev(`
    document.querySelector('.mask').classList.remove('on');
    var day=(new Date().getDay()+6)%7+1;
    var t={id:'__today', name:'今日测试课', teacher:'', location:'', color:'#22B07D',
           sessions:[{day:day, start:1, end:2, weeks:'1-20', room:'', parity:0},
                     {day:day, start:3, end:3, weeks:'1-20', room:'', parity:0}]};
    S.courses.push(t); save();
    switchTab('today'); renderToday();
    var el=document.querySelector('#today-list .ct[data-cid="__today"]');
    if(!el){ S.courses=S.courses.filter(x=>x.id!=='__today'); save(); return {noCard:true, list:document.querySelector('#today-list').innerHTML.slice(0,200)}; }
    var sidx=el.dataset.sidx;
    el.click();
    var f=document.querySelector('#ce-bd .sess-item.focus');
    var r={sidx:sidx, focusIdx:f?f.dataset.esess:null, same: f? String(f.dataset.esess)===String(sidx):false,
           ic:f?f.querySelector('.ic').textContent.replace(/\\s+/g,''):null};
    document.querySelector('.sheet-hd .x').click();
    S.courses=S.courses.filter(x=>x.id!=='__today'); save();
    return r;
  `, "T6");
  ck("T6 今日页点条目 → 高亮索引与条目一致", t6.same === true, t6);
  ck("T6 今日页点条目 → 高亮的是对应那节", t6.focusIdx === t6.sidx, t6);

  // ---- T7：长列表滚动定位（临时课程 8 个课次，聚焦第 8 个）----
  const t7 = await ev(`
    document.querySelector('.mask').classList.remove('on');
    var t={id:'__tmp', name:'临时测试课', teacher:'', location:'', color:'#5B7CFA', sessions:[]};
    for(var i=1;i<=8;i++) t.sessions.push({day:i, start:1, end:1, weeks:'1-20', room:'', parity:0});
    S.courses.push(t);
    openCourseEditor('__tmp', 7);
    var bd=document.querySelector('#ce-bd');
    var f=document.querySelector('#ce-bd .sess-item.focus');
    var r={hasFocus:!!f, idx:f?f.dataset.esess:null, scrollTop:Math.round(bd.scrollTop), scrollH:bd.scrollHeight, clientH:bd.clientHeight};
    document.querySelector('.sheet-hd .x').click();
    S.courses=S.courses.filter(x=>x.id!=='__tmp');
    return r;
  `, "T7");
  ck("T7 长列表：第 8 条被高亮", t7.hasFocus === true && t7.idx === "7", t7);
  ck("T7 长列表：已滚动到可视区（scrollTop>0）", t7.scrollTop > 0, t7);

  // ---- T8：无运行时异常 ----
  ck("T8 无运行时异常", pageErrors.length === 0, pageErrors.slice(0, 3));

  console.log(results.join("\n"));
  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败  (共 " + (pass + fail) + ")");

  ws.close();
  try { proc.kill(); } catch (e) {}
  await sleep(400);
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("失败:", e.message); process.exit(2); });
