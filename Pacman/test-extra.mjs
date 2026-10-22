import fs from "node:fs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
const target = targets.find(t => t.url.includes("pacman.html"));
if (!target) throw new Error("No se encontró la pestaña del juego");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const errors = [];
ws.addEventListener("message", event => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.text);
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  return res.result.value;
};
const snap = () => evaluate("window.__PACMAN_DEBUG__.getSnapshot()");
const key = async (keyName, code, vk) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};
const shot = async name => {
  const res = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(name, Buffer.from(res.data, "base64"));
  console.log("screenshot:", name);
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.setDeviceMetricsOverride", { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.reload", { ignoreCache: true });
await sleep(1000);
await key("Enter", "Enter", 13);
await sleep(2400);

// Túnel: entrar por la izquierda en la fila 14
await evaluate("window.__PACMAN_DEBUG__.teleportPacman(0, 14)");
await key("ArrowLeft", "ArrowLeft", 37);
await sleep(360);
const tunnel = await snap();

// La puerta no debe permitir la entrada a un fantasma normal
await evaluate("window.__PACMAN_DEBUG__.placeGhost('pinky', 13, 11, 'active')");
await sleep(1200);
const door = await snap();

// Completar nivel: dejar una píldora y comerla
await evaluate("window.__PACMAN_DEBUG__.leaveSinglePellet(1, 3); window.__PACMAN_DEBUG__.teleportPacman(1, 4)");
await key("ArrowUp", "ArrowUp", 38);
await sleep(500);
const levelClear = await snap();
await shot("shot-levelclear.png");
await sleep(2400);
const nextLevel = await snap();

// Game over: una vida, contacto mortal, pantalla final
await evaluate("window.__PACMAN_DEBUG__.setLives(1); window.__PACMAN_DEBUG__.setFright(0); const s=window.__PACMAN_DEBUG__.getSnapshot(); window.__PACMAN_DEBUG__.placeGhost('blinky', s.pacman.tx, s.pacman.ty, 'active')");
await sleep(300);
const dying = await snap();
await sleep(1700);
const gameover = await snap();
const overlay = await evaluate("document.getElementById('overlay').innerText");
await shot("shot-gameover.png");
await key("Enter", "Enter", 13);
await sleep(2600);
const restarted = await snap();

// Vista móvil
await send("Page.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(600);
const mobile = await evaluate("(() => { const t=document.getElementById('touchpad'); const c=document.getElementById('game'); const s=document.getElementById('screen'); return {touchpad:getComputedStyle(t).display, canvasW:c.getBoundingClientRect().width, canvasH:c.getBoundingClientRect().height, screenW:s.getBoundingClientRect().width, bodyScrollW:document.body.scrollWidth, innerW:window.innerWidth}; })()");
await shot("shot-mobile.png");

console.log(JSON.stringify({ tunnel, door, levelClear, nextLevel, dying, gameover, overlay, restarted, mobile, errors }, null, 2));
ws.close();
