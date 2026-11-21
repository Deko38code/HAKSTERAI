// Verify freebuff spawns through /terminal?cli=freebuff, answering TUI capability queries.
const WebSocket = require("/home/ghost694/workspace/dekekenneth840@gmail.com/omp-preview/node_modules/ws");
const ws = new WebSocket("ws://127.0.0.1:9191/terminal?home=real&cli=freebuff&cols=120&rows=32");
let out = "", answered = 0, sawFB = false;
const finish = (m) => { console.log(m); try { ws.close(); } catch (e) {} process.exit(0); };
setTimeout(() => finish("--- RESULT ---\nbytes=" + out.length + " answered=" + answered + " saw_freebuff_marker=" + sawFB + "\nfirst400=" + JSON.stringify(out.slice(0, 400))), 12000);
ws.on("open", () => console.log("WS OPEN"));
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
  if (m.t === "x") return finish("PTY EXITED code=" + m.code + " bytes=" + out.length + " out=" + JSON.stringify(out.slice(0, 300)));
  if (m.t !== "o") return;
  out += m.d;
  if (/freebuff|Codebuff|codebuff/i.test(m.d)) sawFB = true;
  // answer xterm.js-style queries so the TUI can proceed
  if (m.d.includes("\x1b[6n")) { ws.send(JSON.stringify({ t: "d", d: "\x1b[1;1R" })); answered++; }
  if (m.d.includes("\x1b[5n")) { ws.send(JSON.stringify({ t: "d", d: "\x1b[0n" })); answered++; }
  if (m.d.includes("\x1b[?2026$p")) { ws.send(JSON.stringify({ t: "d", d: "\x1b[?2026;2$y" })); answered++; }
  if (m.d.includes("\x1b[?2004$p")) { ws.send(JSON.stringify({ t: "d", d: "\x1b[?2004;1$y" })); answered++; }
  if (m.d.includes("\x1b[?1004$p")) { ws.send(JSON.stringify({ t: "d", d: "\x1b[?1004;1$y" })); answered++; }
});
ws.on("error", (e) => finish("WS ERROR: " + e.message));
