// Verify the dashboard terminal spawns freebuff when cli=freebuff
const WebSocket = require("/home/ghost694/workspace/dekekenneth840@gmail.com/omp-preview/node_modules/ws");
const ws = new WebSocket("ws://127.0.0.1:9191/terminal?cli=freebuff&home=real");
let out = "";
const done = (msg) => { console.log(msg); try { ws.close(); } catch (e) {} process.exit(0); };
setTimeout(() => done("TIMEOUT after 20s. Output so far:\n" + out.slice(0, 900)), 20000);
ws.on("open", () => console.log("WS OPEN"));
ws.on("message", (raw) => {
  try {
    const m = JSON.parse(raw.toString());
    if (m.t === "o") { out += m.d; }
    else if (m.t === "x") { done("EXITED code=" + m.code + "\n--- output ---\n" + out.slice(0, 900)); }
  } catch (e) {}
});
ws.on("error", (e) => done("WS ERROR: " + e.message));
