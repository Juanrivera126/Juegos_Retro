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
const exceptions = [];
const consoleErrors = [];

ws.addEventListener("message", event => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") {
    exceptions.push(msg.params.exceptionDetails);
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    consoleErrors.push(msg.params.args.map(a => a.value || a.description).join(" "));
  }
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
    consoleErrors.push(msg.params.entry.text);
  }
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error("Evaluate exception: " + JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
}

async function snapshot() {
  return evaluate("window.__PACMAN_DEBUG__.getSnapshot()");
}

async function key(keyName, code, vk) {
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: keyName,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyName,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk
  });
}

async function shot(name) {
  const result = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(name, Buffer.from(result.data, "base64"));
  console.log("screenshot:", name, Buffer.from(result.data, "base64").length, "bytes");
}

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Page.setDeviceMetricsOverride", {
  width: 1100,
  height: 1200,
  deviceScaleFactor: 1,
  mobile: false
});
await send("Page.reload", { ignoreCache: true });
await sleep(1300);

const results = {};
results.initial = await snapshot();
results.overlayInitial = await evaluate("document.getElementById('overlay').classList.contains('is-visible')");
await shot("shot-start.png");

await key("Enter", "Enter", 13);
await sleep(2600);
results.afterStart = await snapshot();
await shot("shot-playing.png");

await key("ArrowRight", "ArrowRight", 39);
await sleep(320);
results.afterReverse = await snapshot();
await key("ArrowLeft", "ArrowLeft", 37);
await sleep(120);

await key("p", "KeyP", 80);
await sleep(250);
results.paused = await snapshot();
results.overlayPaused = await evaluate("document.getElementById('overlay').innerText");
await shot("shot-paused.png");
await key("p", "KeyP", 80);
await sleep(250);
results.resumed = await snapshot();

await evaluate("window.__PACMAN_DEBUG__.teleportPacman(1, 4)");
await key("ArrowUp", "ArrowUp", 38);
await sleep(650);
results.power = await snapshot();
await shot("shot-power.png");

await evaluate("window.__PACMAN_DEBUG__.setFright(7); window.__PACMAN_DEBUG__.placeGhost('blinky', window.__PACMAN_DEBUG__.getSnapshot().pacman.tx, window.__PACMAN_DEBUG__.getSnapshot().pacman.ty, 'active')");
await sleep(350);
results.afterGhostContact = await snapshot();

await evaluate("window.__PACMAN_DEBUG__.setFright(0); window.__PACMAN_DEBUG__.placeGhost('blinky', window.__PACMAN_DEBUG__.getSnapshot().pacman.tx, window.__PACMAN_DEBUG__.getSnapshot().pacman.ty, 'active')");
await sleep(350);
results.afterDangerContact = await snapshot();
await sleep(1700);
results.afterDeath = await snapshot();

results.overlayAfterDeath = await evaluate("document.getElementById('overlay').className");
results.hud = await evaluate("({score:document.getElementById('score').textContent, level:document.getElementById('level').textContent, lives:document.getElementById('lives').children.length, high:document.getElementById('highScore').textContent})");
results.consoleErrors = consoleErrors;
results.exceptions = exceptions.map(e => e.text || e.exception?.description || JSON.stringify(e));

console.log(JSON.stringify(results, null, 2));
ws.close();
