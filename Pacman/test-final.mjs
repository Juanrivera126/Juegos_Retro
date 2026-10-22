import fs from "node:fs";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
const target = targets.find(t => t.url.includes("pacman.html"));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
let id = 1; const pending = new Map(); const errors = [];
ws.addEventListener("message", ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return; }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const n = id++; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const evalJS = async expression => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
const snap = () => evalJS("window.__PACMAN_DEBUG__.getSnapshot()");
const key = async (k, code, vk) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};
const shot = async name => { const r = await send("Page.captureScreenshot", { format: "png", fromSurface: true }); fs.writeFileSync(name, Buffer.from(r.data, "base64")); };

await send("Page.enable"); await send("Runtime.enable");
await send("Page.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
await send("Page.reload", { ignoreCache: true });
await sleep(1000);
const layout768 = await evalJS("(() => { const c=document.querySelector('.cabinet').getBoundingClientRect(); const s=document.getElementById('screen').getBoundingClientRect(); return {cabTop:c.top,cabBottom:c.bottom,cabW:c.width,screenW:s.width,screenH:s.height,innerH:innerHeight,scrollH:document.body.scrollHeight}; })()");
await shot("shot-1366x768.png");

await key("Enter", "Enter", 13);
await sleep(2200);
const playing = await snap();
await evalJS("window.__PACMAN_DEBUG__.setLives(1); window.__PACMAN_DEBUG__.setFright(0); const s=window.__PACMAN_DEBUG__.getSnapshot(); window.__PACMAN_DEBUG__.placeGhost('blinky', s.pacman.tx, s.pacman.ty, 'active')");
await sleep(300);
const died = await snap();
await sleep(1900);
const over = await snap();
const overText = await evalJS("document.getElementById('overlay').innerText");
const overClass = await evalJS("document.getElementById('overlay').className");
await shot("shot-gameover-desktop.png");
await key("Enter", "Enter", 13);
await sleep(2300);
const restarted = await snap();
const restoredHud = await evalJS("({score:document.getElementById('score').textContent,lives:document.getElementById('lives').children.length,high:document.getElementById('highScore').textContent,overlay:document.getElementById('overlay').className})");

console.log(JSON.stringify({ layout768, playing, died, over, overText, overClass, restarted, restoredHud, errors }, null, 2));
ws.close();
