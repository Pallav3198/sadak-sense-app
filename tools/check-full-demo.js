// Opens the built driver app in a real Edge or Chrome window, runs Full demo end to end and prints
// step timings, speech start/end/error counts, the air-quality strip and any page errors.
// Usage: node tools/check-full-demo.js "<path to msedge.exe>" 9360 http://127.0.0.1:8768/drive.html
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");
const [, , exe, port, url] = process.argv;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-"));
const proc = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", url], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let tab;
  for (let i = 0; i < 40 && !tab; i++) { await sleep(500); try { tab = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page" && t.url.includes("drive")); } catch {} }
  const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const wait = new Map(), errs = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) wait.get(d.id)(d);
    if (d.method === "Runtime.exceptionThrown") errs.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === "Runtime.consoleAPICalled" && ["warning", "error"].includes(d.params.type)) errs.push(d.params.args.map((x) => x.value || x.description).join(" ")); };
  const ev = (expression, userGesture = false) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, userGesture, awaitPromise: true, returnByValue: true } })); }).then((d) => d.result.result?.value);
  ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable" }));
  await sleep(3000);
  await ev(`window.ALL=[];{const b=bubble;bubble=(c,w,t)=>{ALL.push(w+': '+t);b(c,w,t)}};window.SP={start:0,end:0,err:[]};{const rs=speechSynthesis.speak.bind(speechSynthesis);speechSynthesis.speak=u=>{u.addEventListener('start',()=>SP.start++);u.addEventListener('end',()=>SP.end++);u.addEventListener('error',x=>SP.err.push(x.error));rs(u)}}
    document.getElementById('carSel').value='aura';document.getElementById('people').value='5';1`);
  const t0 = Date.now();
  await ev(`document.getElementById('fullBtn').click();1`, true);
  let last = "", began = false;
  while (Date.now() - t0 < 320000) { await sleep(1500); const bar = await ev(`S.tour?document.getElementById('tourT').textContent:'END'`); if (bar !== last) { console.log(Math.round((Date.now() - t0) / 1000) + "s", bar); last = bar; } if (bar !== "END") began = true; if (bar === "END" && began) break; }
  await sleep(4000);
  console.log(JSON.stringify(await ev(`({envBar:document.getElementById('envTxt').textContent,envAct:document.getElementById('envAct').textContent,liveEnv:S.env,speech:SP,lines:ALL.filter(x=>/mausam|brake|Air|weather/i.test(x)),pendingAgent:!!S.pendingAgent})`)));
  console.log("errors", JSON.stringify(errs));
  proc.kill(); process.exit(0);
})().catch((e) => { console.log("ERR", e.message); proc.kill(); process.exit(1); });
