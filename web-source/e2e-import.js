/* 课表导入器端到端测试。
   在真实浏览器里跑真实解析代码，覆盖各种教务系统导出格式。

   为什么这件事必须测：
     导入器的价值全在「各种奇怪格式能不能吃进去」。解析函数是本项目里
     分支最多的代码 —— 单双周、大节制、四位数紧凑写法、表头别名、
     引号包裹的 CSV、节次越界…… 每一条都是一个真实世界会遇到的差异。
     靠人工点几下根本覆盖不到，只能写死样本断言。

   运行前需要本地服务：
     cd class-schedule && python -m http.server 8124
     node e2e-import.js
*/
const { spawn } = require("child_process");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9365;
const BASE = "http://127.0.0.1:8124/index.html";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const out = [];
const ck = (n, c, e) => {
  if (c) { pass++; out.push("  PASS  " + n); }
  else { fail++; out.push("  FAIL  " + n + "  -> " + JSON.stringify(e)); }
};

async function main() {
  const prof = "C:\\Users\\lenovo\\AppData\\Local\\Temp\\edge-import-" + Date.now();
  // 直接以目标 URL 启动。之前用 about:blank 启动再 Page.navigate 的写法，
  // 会在 /json/version 上连到那个空白 target —— 求值全部落空、脚本看着像没执行。
  // 正确做法是从 /json/list 里按 URL 挑出真正的页面 target。
  const edge = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + prof, BASE + "?n=" + Date.now()
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const arr = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
      const page = arr.find(t => t.type === "page" && t.url.indexOf("index.html") >= 0);
      if (page) { target = page; break; }
    } catch (e) {}
  }
  if (!target) { console.log("浏览器没起来或页面未加载"); edge.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });

  let mid = 0; const waiting = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  const send = (method, params) => new Promise(res => {
    const id = ++mid; waiting.set(id, res);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });

  await send("Runtime.enable");
  await sleep(1500);

  const ev = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    const res = r.result || {};
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      return "!!" + (d.exception && d.exception.description || d.text);
    }
    return res.result ? res.result.value : undefined;
  };

  /* 用函数体包一层再取返回值：避免 IIFE 抛异常时拿到 "!!..." 字符串，
     直接把异常原样抛出来，报错定位才准。 */
  const evJson = async (body) => {
    const wrapped = `(function(){ try { return JSON.stringify((function(){ ${body} })()); }
                                  catch(e){ return "!!EXC: " + (e && e.message || e); } })()`;
    const raw = await ev(wrapped);
    if (typeof raw === "string" && raw.startsWith("!!")) throw new Error("页面内异常 -> " + raw);
    if (raw === undefined) throw new Error("求值返回 undefined（检查 target / 变量名）");
    return JSON.parse(raw);
  };

  // 解析器是否已挂到 window 上（页面脚本用 const 声明，需通过函数调用访问）
  const hasFn = await ev("typeof parseScheduleText === 'function'");
  ck("parseScheduleText 已定义", hasFn === true, hasFn);

  /* ---------- 样本 1：标准 CSV（带表头，逗号分隔） ---------- */
  const csv1 = `课程名称,星期,节次,周次,教室,教师
高等数学,周一,1-2,1-16,教三201,张伟
大学英语,周三,3-4,1-16,外语楼105,李娜
高等数学,周五,1-2,1-16,教三201,张伟`;
  let r1 = await evJson(`return parseScheduleText(${JSON.stringify(csv1)});`);
  let o1 = r1;
  ck("CSV：识别出 2 门课（高等数学合并了 2 次课）", o1.count === 2, o1.count);
  ck("CSV：模式为 parsed", o1.mode === "parsed", o1.mode);
  const gm = o1.courses.find(c => c.name === "高等数学");
  ck("CSV：高等数学有 2 个课次", gm && gm.sessions.length === 2, gm && gm.sessions.length);
  ck("CSV：教师被带入", gm && gm.teacher === "张伟", gm && gm.teacher);

  /* ---------- 样本 2：制表符分隔 + 教师列在教室后 ---------- */
  const tsv = "课程名称\t上课星期\t上课节次\t上课周次\t上课教室\t任课教师\n" +
              "大学物理\t星期三\t1-2\t1-16\t理教401\t王强";
  let r2 = await evJson(`return parseScheduleText(${JSON.stringify(tsv)});`);
  let o2 = r2;
  ck("TSV：自动识别制表符分隔", o2 && o2.count === 1, o2 && o2.count);
  ck("TSV：表头别名「上课星期」被识别", o2 && o2.courses[0].sessions[0].day === 3, o2 && o2.courses[0].sessions[0].day);

  /* ---------- 样本 3：单双周 ---------- */
  const csv3 = `课程名称,星期,节次,周次,教室
思想道德与法治,周二,1-2,1-16,人文楼201
形势与政策,周四,1-2,1-15单周,人文楼202
军事理论,周四,1-2,2-16双周,人文楼202`;
  let r3 = await evJson(`return parseScheduleText(${JSON.stringify(csv3)});`);
  let o3 = r3;
  const sx = o3.courses.find(c => c.name === "形势与政策");
  const js = o3.courses.find(c => c.name === "军事理论");
  ck("单周：parity=1", sx && sx.sessions[0].parity === 1, sx && sx.sessions[0].parity);
  ck("单周：周次范围 1-15", sx && sx.sessions[0].weeks === "1-15", sx && sx.sessions[0].weeks);
  ck("双周：parity=2", js && js.sessions[0].parity === 2, js && js.sessions[0].parity);
  ck("双周：周次范围 2-16", js && js.sessions[0].weeks === "2-16", js && js.sessions[0].weeks);

  /* ---------- 样本 4：四位数紧凑节次写法（教务系统常见） ---------- */
  const csv4 = `课程名称,星期,节次,周次,教室
数据结构,周二,0102,1-16,计算机楼302`;
  let r4 = await evJson(`return parseScheduleText(${JSON.stringify(csv4)});`);
  let o4 = r4;
  ck("紧凑节次 0102 → 第1节到第2节", o4 && o4.courses[0].sessions[0].start === 1 && o4.courses[0].sessions[0].end === 2,
     o4 && [o4.courses[0].sessions[0].start, o4.courses[0].sessions[0].end]);

  /* ---------- 样本 5：拆分的起止节次列 ---------- */
  const csv5 = `课程名称,星期,开始节次,结束节次,周次,教室
线性代数,周四,3,4,1-16,教二105`;
  let r5 = await evJson(`return parseScheduleText(${JSON.stringify(csv5)});`);
  let o5 = r5;
  ck("起止分列：3 到 4", o5 && o5.courses[0].sessions[0].start === 3 && o5.courses[0].sessions[0].end === 4,
     o5 && [o5.courses[0].sessions[0].start, o5.courses[0].sessions[0].end]);

  /* ---------- 样本 6：课程名含逗号（引号包裹） ---------- */
  const csv6 = `课程名称,星期,节次,周次,教室
"程序设计, 上机",周一,3-4,1-16,机房A`;
  let r6 = await evJson(`return parseScheduleText(${JSON.stringify(csv6)});`);
  let o6 = r6;
  ck("引号内的逗号不破坏解析", o6 && o6.courses[0].name === "程序设计, 上机", o6 && o6.courses[0].name);

  /* ---------- 样本 7：英文表头（部分教务系统导出英文） ---------- */
  const csv7 = `name,teacher,weekday,section,weeks,room
Algorithms,Smith,Mon,1-2,1-16,Room 301`;
  let r7 = await evJson(`return parseScheduleText(${JSON.stringify(csv7)});`);
  let o7 = r7;
  ck("英文表头被识别", o7 && o7.count === 1, o7 && o7.count);
  ck("英文星期 Mon → 1", o7 && o7.courses[0].sessions[0].day === 1, o7 && o7.courses[0].sessions[0].day);

  /* ---------- 样本 8：教务系统 JSON（data 数组 + 中文字段） ---------- */
  const json8 = JSON.stringify({
    code: 0,
    data: [
      { kcmc: "概率论与数理统计", xqj: "星期二", jcs: "1-2", zcd: "1-16", cdmc: "教四208", jsxm: "陈老师" },
      { kcmc: "大学体育", xqj: "星期四", jcs: "5-6", zcd: "1-16", cdmc: "体育馆", jsxm: "刘老师" }
    ]
  });
  // 这套字段名不在别名表里 —— 用来验证「识别不了就明确返回 null」而不是瞎猜
  let r8 = await evJson(`return parseScheduleText(${JSON.stringify(json8)});`);
  ck("陌生字段名的 JSON 返回 null（不瞎猜）", r8 === undefined || r8 === null || r8 === "null",
     r8 === undefined ? "(undefined)" : r8);

  /* ---------- 样本 9：带常见别名的 JSON ---------- */
  const json9 = JSON.stringify({
    list: [
      { "课程名称": "离散数学", "星期": "周一", "节次": "3-4", "周次": "1-16", "教室": "教五101", "教师": "赵老师" },
      { "课程名称": "离散数学", "星期": "周三", "节次": "3-4", "周次": "1-16", "教室": "教五101", "教师": "赵老师" }
    ]
  });
  let r9 = await evJson(`return parseScheduleText(${JSON.stringify(json9)});`);
  let o9 = r9;
  ck("中文别名 JSON：合并成 1 门课 2 个课次", o9 && o9.count === 1 && o9.courses[0].sessions.length === 2,
     o9 && [o9.count, o9.courses[0].sessions.length]);

  /* ---------- 样本 10：我们自己的备份格式（原生直通） ---------- */
  const nativeJson = JSON.stringify({
    title: "备份",
    settings: { startDate: "2026-08-31", totalWeeks: 20, days: [1,2,3,4,5], notifyEnabled: false, notifyAhead: 15,
                sections: [{n:1,label:"1-2",start:"08:20",end:"09:55"}] },
    courses: [{ id:"c1", name:"测试课", teacher:"T", location:"L", color:"#4F6DF5",
                sessions:[{day:1,start:1,end:1,weeks:"1-16",parity:0,room:"R1"}] }]
  });
  let r10 = await evJson(`return parseScheduleText(${JSON.stringify(nativeJson)});`);
  let o10 = r10;
  ck("自家备份格式走 native 直通", o10 && o10.mode === "native", o10 && o10.mode);
  ck("native 模式课程数正确", o10 && o10.count === 1, o10 && o10.count);

  /* ---------- 样本 11：垃圾输入必须安全返回 ---------- */
  const junk = ["", "hello world", "|||", "1,2,3\n4,5,6", "{\"broken\":", "课程名,星期\n没有节次,周一"];
  let junkOk = true; const junkDetail = [];
  for (const j of junk) {
    // evJson 走的是 JSON.stringify，所以 null 会变成字符串 "null"。
    // 这里用原始 ev 取 typeof，判断更直接，不受序列化影响。
    const raw = await ev(`(function(){ try { return String(parseScheduleText(${JSON.stringify(j)}) === null ? "NULL" : typeof parseScheduleText(${JSON.stringify(j)})); } catch(e){ return "THREW:" + e.message; } })()`);
    // 允许：NULL（识别不了）。不允许：抛异常、返回非对象。
    if (raw !== "NULL" && raw !== "object") { junkOk = false; junkDetail.push(JSON.stringify(j) + " -> " + raw); }
    if (String(raw).indexOf("THREW") === 0) { junkOk = false; junkDetail.push(JSON.stringify(j) + " 抛异常"); }
  }
  ck("垃圾输入不崩溃、不产生异常", junkOk, junkDetail);

  /* ---------- 样本 12：节次越界被剔除 ---------- */
  /* ---------- 样本 12：节次越界被剔除 ---------- */
  const r12 = await evJson(`
    const res = parseScheduleText(${JSON.stringify(`课程名称,星期,节次,周次,教室
越界课,周一,1-2,1-16,教A
越界课,周二,99-100,1-16,教B`)});
    S.courses = [];
    const dropped = commitImport(res, false);
    return { dropped: dropped, courses: S.courses.length,
             sessions: S.courses[0] ? S.courses[0].sessions.length : 0 };
  `);
  ck("越界节次被剔除并计数", r12.dropped === 1, r12.dropped);
  ck("剔除后仍保留合法课次", r12.sessions === 1, r12.sessions);

  /* ---------- 样本 13：合并模式不覆盖已有课程 ---------- */
  const r13 = await evJson(`
    S.courses = [{ id:"x1", name:"已有课", teacher:"", location:"", color:"#4F6DF5",
                   sessions:[{day:5,start:1,end:1,weeks:"1-16",parity:0,room:""}] }];
    const res = parseScheduleText(${JSON.stringify("课程名称,星期,节次,周次,教室\n新来的课,周一,1-2,1-16,教A")});
    commitImport(res, true);
    return { total: S.courses.length, names: S.courses.map(c=>c.name).sort() };
  `);
  ck("合并模式保留已有课程", r13.names.indexOf("已有课") >= 0, r13.names);
  ck("合并模式加入新课程", r13.names.indexOf("新来的课") >= 0, r13.names);
  ck("合并后共 2 门课", r13.total === 2, r13.total);

  /* ---------- 样本 14：同名课程重复导入不产生重复课次 ---------- */
  const r14 = await evJson(`
    S.courses = [];
    const src = ${JSON.stringify("课程名称,星期,节次,周次,教室\n重复课,周一,1-2,1-16,教A")};
    commitImport(parseScheduleText(src), false);
    commitImport(parseScheduleText(src), true);   // 同样内容再合并一次
    return { courses: S.courses.length, sessions: S.courses[0] ? S.courses[0].sessions.length : 0 };
  `);
  ck("重复导入同名课程不新增课次", r14.sessions === 1, r14.sessions);

  /* ---------- 样本 15：导入面板能打开、元素齐全 ---------- */
  await ev("openImportSheet()");
  await sleep(250);
  const ui = await evJson(`
    return {
      hasText: !!document.querySelector("#imp-text"),
      hasFile: !!document.querySelector("#imp-file"),
      hasMerge: !!document.querySelector("#imp-merge"),
      hasGo: !!document.querySelector("#imp-go"),
      maskOn: document.querySelector("#mask").classList.contains("on")
    };
  `);
  ck("导入面板打开", ui.maskOn === true, ui.maskOn);
  ck("面板含粘贴框", ui.hasText === true, ui.hasText);
  ck("面板含选文件按钮", ui.hasFile === true, ui.hasFile);
  ck("面板含合并开关", ui.hasMerge === true, ui.hasMerge);
  ck("面板含导入按钮", ui.hasGo === true, ui.hasGo);

  /* ---------- 样本 16：面板内点导入真的改数据 ---------- */
  const r16 = await evJson(`
    S.courses = [];
    document.querySelector("#imp-text").value = ${JSON.stringify("课程名称,星期,节次,周次,教室\n面板导入课,周三,5-6,1-16,教C")};
    document.querySelector("#imp-go").click();
    return null;   // 点击是同步的，但结果在下一个 tick 才落库，下面再取
  `);
  await sleep(500);
  const after = await evJson(`
    return { count: S.courses.length, name: S.courses[0] ? S.courses[0].name : "",
             maskOn: document.querySelector("#mask").classList.contains("on") };
  `);
  ck("面板导入生效", after.count === 1 && after.name === "面板导入课", after);
  ck("导入后面板关闭", after.maskOn === false, after.maskOn);

  /* ---------- 收尾 ---------- */
  ws.close();
  edge.kill();
  console.log(out.join("\n"));
  console.log("\n" + "=".repeat(52));
  console.log(`  导入器测试：${pass} 通过 / ${fail} 失败`);
  console.log("=".repeat(52));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error("崩了:", e); process.exit(1); });
