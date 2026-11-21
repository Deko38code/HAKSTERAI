// Final combined verification: freebuff PTY, kiro PTY, UI toggle. Fast deadlines.
const WebSocket = require("/home/ghost694/workspace/dekekenneth840@gmail.com/omp-preview/node_modules/ws");

function probe(url, ms) {
  return new Promise((res) => {
    let bytes = 0, frames = 0, closeInfo = "";
    const ws = new WebSocket(url);
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} res({ url, bytes, frames, closeInfo, timedOut: false }); }, ms);
    ws.on("open", () => {});
    ws.on("message", (raw) => {
      frames++;
      let m = null; try { m = JSON.parse(raw.toString()); } catch (e) {}
      if (m && m.t === "o") {
        bytes += m.d.length;
        if (m.d.includes("\x1b[6n")) ws.send(JSON.stringify({ t: "d", d: "\x1b[1;1R" }));
        if (m.d.includes("\x1b[?2026$p")) ws.send(JSON.stringify({ t: "d", d: "\x1b[?2026;2$y" }));
        if (m.d.includes("\x1b[?2004$p")) ws.send(JSON.stringify({ t: "d", d: "\x1b[?2004;1$y" }));
        if (m.d.includes("\x1b[?1004$p")) ws.send(JSON.stringify({ t: "d", d: "\x1b[?1004;1$y" }));
      }
    });
    ws.on("close", (c, r) => { clearTimeout(t); res({ url, bytes, frames, closeInfo: "code=" + c + " reason=" + (r ? r.toString() : ""), timedOut: false }); });
    ws.on("error", (e) => { clearTimeout(t); res({ url, bytes, frames, closeInfo: "ERR " + e.message, timedOut: false }); });
  });
}

(async () => {
  const fb = await probe("ws://127.0.0.1:9191/terminal?home=real&cli=freebuff&cols=120&rows=32", 6000);
  const ki = await probe("ws://127.0.0.1:9191/terminal?home=real&cli=kiro&cols=100&rows=30", 5000);
  console.log("FREEBUFF: bytes=" + fb.bytes + " frames=" + fb.frames + " " + fb.closeInfo);
  console.log("KIRO:     bytes=" + ki.bytes + " frames=" + ki.frames + " " + ki.closeInfo);
  process.exit(0);
})();
