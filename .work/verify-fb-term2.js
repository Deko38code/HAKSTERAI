// Verify freebuff PTY spawn + answer terminal capability queries like xterm.js would.
const WebSocket = require("/home/ghost694/workspace/dekekenneth840@gmail.com/omp-preview/node_modules/ws");
const ws = new WebSocket("ws://127.0.0.1:9191/terminal?cli=freebuff&home=real&cols=120&rows=32");
let out = "", answered = 0;
const done = (m) => { console.log(m); try { ws.close(); } catch (e) {} process.exit(0); };
setTimeout(() => done("--- RESULT ---\nbytes=" + out.length + " answered_queries=" + answered + "\n" + out.slice(0, 600)), 15000);
ws.on("open", () => console.log("WS OPEN"));
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
  if (m.t !== "o") { if (m.t === "x") done("EXITED code=" + m.code + " bytes=" + out.length); return; }
  out += m.d;
  // Answer cursor position request ESC[6n -> report 1;1
  if (m.d.includes("\x1b[6n")) { ws.send(JSON.stringify({ t: "d", d: "\x1b[1;1R" })); answered++; }
  // Answer device status ESC[5n -> OK
  if (m.d.includes("\x1b[5n")) { ws.send(JSON.stringify({ t: "d", d: "\x1b[0n" })); answered++; }
});
ws.on("error", (e) => done("WS ERROR: " + e.message));
