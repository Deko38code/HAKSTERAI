// Show EVERY frame + close code/reason from the terminal websocket.
const WebSocket = require("/home/ghost694/workspace/dekekenneth840@gmail.com/omp-preview/node_modules/ws");
const url = process.argv[2] || "ws://127.0.0.1:9191/terminal?home=real&cli=freebuff&cols=120&rows=32";
console.log("CONNECT " + url);
const ws = new WebSocket(url);
let n = 0, bytes = 0;
setTimeout(() => { console.log("--- DONE frames=" + n + " bytes=" + bytes); process.exit(0); }, 9000);
ws.on("open", () => console.log("OPEN"));
ws.on("message", (raw) => {
  n++;
  const t = raw.toString();
  let m = null; try { m = JSON.parse(t); } catch (e) {}
  if (m && m.t === "o") {
    bytes += m.d.length;
    if (m.d.includes("\x1b[6n")) ws.send(JSON.stringify({ t: "d", d: "\x1b[1;1R" }));
    if (m.d.includes("\x1b[?2026$p")) ws.send(JSON.stringify({ t: "d", d: "\x1b[?2026;2$y" }));
    if (n <= 3) console.log("frame" + n + " t=o len=" + m.d.length + " " + JSON.stringify(m.d.slice(0, 120)));
  } else {
    console.log("frame" + n + " " + t.slice(0, 240));
  }
});
ws.on("close", (c, r) => console.log("CLOSE code=" + c + " reason=" + (r ? r.toString() : "") + " frames=" + n + " bytes=" + bytes));
ws.on("error", (e) => console.log("ERROR " + e.message));
