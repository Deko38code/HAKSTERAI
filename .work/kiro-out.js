const W = require("/home/ghost694/workspace/dekekenneth840@gmail.com/omp-preview/node_modules/ws");
const ws = new W("ws://127.0.0.1:9191/terminal?home=real&cli=kiro");
let o = "";
ws.on("message", (r) => { try { const m = JSON.parse(r.toString()); if (m.t === "o") o += m.d; } catch (e) {} });
setTimeout(() => { console.log("KIRO_OUTPUT=" + JSON.stringify(o.slice(0, 400))); process.exit(0); }, 4000);
