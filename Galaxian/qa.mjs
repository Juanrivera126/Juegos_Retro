import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = process.cwd();
const gameUrl = pathToFileURL(path.join(outDir, "index.html")).href;

const targets = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("No page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const events = [];
const errors = [];

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
    return;
  }
  events.push(msg);
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    errors.push({
      text: d?.text || "exception",
      description: d?.exception?.description || "",
      url: d?.url || "",
      line: d?.lineNumber,
      column: d?.columnNumber
    });
  }
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
    errors.push({ text: msg.params.entry.text, source: msg.params.entry.source });
  }
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result.value;
}

async function waitFor(expression, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(80);
  }
  return false;
}

async function screenshot(name, fullPage = false) {
  const res = await send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: fullPage
  });
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  return file;
}

async function key(type, code, keyValue) {
  const vk = code === "ArrowRight" ? 39 : code === "ArrowLeft" ? 37 :
    code === "ArrowUp" ? 38 : code === "ArrowDown" ? 40 : code === "Space" ? 32 : 0;
  await send("Input.dispatchKeyEvent", {
    type,
    key: keyValue,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} | ${JSON.stringify(detail)}`);
}

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1120,
  deviceScaleFactor: 1,
  mobile: false
});
await send("Page.navigate", { url: gameUrl });
await waitFor("document.readyState === 'complete'");
await sleep(900);
errors.length = 0;

const title = await evaluate("document.title");
const initial = await evaluate("window.__GALAXIAN__.snapshot()");
check("El título y el motor cargan", title.includes("GALAXIAN") && initial.mode === "attract", { title, mode: initial.mode });
check("La cuadrícula tiene 4 rangos y 24 naves", initial.totalEnemies === 24 &&
  new Set(initial.enemies.map((e) => e.type)).size === 4,
  { total: initial.totalEnemies, types: [...new Set(initial.enemies.map((e) => e.type))] });
check("El jugador comienza en la línea inferior", initial.player.y === 636 && initial.player.lane === 0, initial.player);

const footer = await evaluate("document.querySelector('footer').innerText.trim()");
check("Footer exacto solicitado", footer === "Diseñado por Juan Guillermo Rivera Berrío con tecnología DeepSeek V 4.1", footer);

const swayA = await evaluate("window.__GALAXIAN__.snapshot().enemies[0].x");
await sleep(700);
const swayB = await evaluate("window.__GALAXIAN__.snapshot().enemies[0].x");
check("La formación se desplaza lateralmente de forma conjunta", Math.abs(swayB - swayA) >= 3, { before: swayA, after: swayB, delta: swayB - swayA });

const overflow = await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1");
check("Sin desbordamiento horizontal en escritorio", overflow, await evaluate("({sw:document.documentElement.scrollWidth,iw:window.innerWidth})"));

await screenshot("shot-01-attract.png", true);

// Arranque mediante el botón visible.
await evaluate("document.getElementById('startBtn').click()");
await sleep(650);
let state = await evaluate("window.__GALAXIAN__.snapshot()");
check("El botón inicia la partida", state.mode === "playing", { mode: state.mode, score: state.score, lives: state.lives });
const overlayHidden = await evaluate("getComputedStyle(document.getElementById('overlay')).visibility === 'hidden'");
check("El overlay desaparece al jugar", overlayHidden, overlayHidden);

// Movimiento estrictamente horizontal.
const moveBefore = await evaluate("window.__GALAXIAN__.snapshot()");
await key("keyDown", "ArrowRight", "ArrowRight");
await sleep(750);
await key("keyUp", "ArrowRight", "ArrowRight");
await sleep(80);
const moveAfter = await evaluate("window.__GALAXIAN__.snapshot()");
const moved = moveAfter.player.x - moveBefore.player.x;
check("La Galaxip se mueve a la derecha", moved > 80, { before: moveBefore.player.x, after: moveAfter.player.x, delta: moved });
check("El movimiento horizontal no altera la línea", moveAfter.player.y === moveBefore.player.y && moveAfter.player.y === 636, { y: moveAfter.player.y });

// Cambio de línea vertical: exactamente dos posiciones.
await key("keyDown", "ArrowUp", "ArrowUp");
await key("keyUp", "ArrowUp", "ArrowUp");
await sleep(420);
const highLane = await evaluate("window.__GALAXIAN__.snapshot().player");
check("La Galaxip sube exactamente una línea", highLane.lane === 1 && Math.abs(highLane.y - 582) < 0.5,
  { lane: highLane.lane, y: highLane.y, expected: 582 });
await key("keyDown", "ArrowUp", "ArrowUp");
await key("keyUp", "ArrowUp", "ArrowUp");
await sleep(180);
const stillHigh = await evaluate("window.__GALAXIAN__.snapshot().player");
check("No existe una tercera línea superior", stillHigh.lane === 1 && Math.abs(stillHigh.y - 582) < 0.5,
  { lane: stillHigh.lane, y: stillHigh.y });
await key("keyDown", "ArrowDown", "ArrowDown");
await key("keyUp", "ArrowDown", "ArrowDown");
await sleep(420);
const lowLane = await evaluate("window.__GALAXIAN__.snapshot().player");
check("La Galaxip baja a la línea inferior", lowLane.lane === 0 && Math.abs(lowLane.y - 636) < 0.5,
  { lane: lowLane.lane, y: lowLane.y, expected: 636 });
await key("keyDown", "ArrowDown", "ArrowDown");
await key("keyUp", "ArrowDown", "ArrowDown");
await sleep(180);
const stillLow = await evaluate("window.__GALAXIAN__.snapshot().player");
check("No existe una tercera línea inferior", stillLow.lane === 0 && Math.abs(stillLow.y - 636) < 0.5,
  { lane: stillLow.lane, y: stillLow.y });

// Disparo.
await key("keyDown", "Space", " ");
await sleep(90);
const firing = await evaluate("window.__GALAXIAN__.snapshot()");
await key("keyUp", "Space", " ");
check("El disparo crea proyectiles", firing.bullets > 0, { bullets: firing.bullets });

// La nueva línea superior permite esquivar un proyectil que cruza la inferior.
await evaluate(`window.__GALAXIAN__.start();
  window.__GALAXIAN__.setInvulnerable(0);
  window.__GALAXIAN__.setLane(1);`);
await sleep(420);
const dodgeState = await evaluate("window.__GALAXIAN__.snapshot()");
await evaluate(`window.__GALAXIAN__.spawnTestBullet(${dodgeState.player.x}, 636, 0, 0, 4)`);
await sleep(400);
const afterDodge = await evaluate("window.__GALAXIAN__.snapshot()");
check("La línea superior esquiva un proyectil de la línea inferior",
  afterDodge.player.dead === false && afterDodge.lives === 3 && Math.abs(afterDodge.player.y - 582) < 0.5,
  { dead: afterDodge.player.dead, lives: afterDodge.lives, y: afterDodge.player.y });
await evaluate("window.__GALAXIAN__.setLane(0)");
await sleep(420);
const afterLaneDrop = await evaluate("window.__GALAXIAN__.snapshot()");
check("El mismo proyectil impacta al bajar a su línea",
  afterLaneDrop.player.dead === true && afterLaneDrop.lives === 2,
  { dead: afterLaneDrop.player.dead, lives: afterLaneDrop.lives, lane: afterLaneDrop.player.lane });

// Puntuación estática.
await evaluate("window.__GALAXIAN__.start()");
await sleep(300);
const beforeStatic = await evaluate("window.__GALAXIAN__.snapshot()");
const drone = beforeStatic.enemies.find((e) => e.type === "drone" && e.state === "formation");
await evaluate(`window.__GALAXIAN__.killEnemy(${drone.id})`);
const afterStatic = await evaluate("window.__GALAXIAN__.snapshot()");
check("Dron en formación vale 60 puntos", afterStatic.score - beforeStatic.score === 60,
  { delta: afterStatic.score - beforeStatic.score, score: afterStatic.score });

// Disparo real contra una nave de la formación.
await evaluate("window.__GALAXIAN__.start()");
await sleep(250);
const targetState = await evaluate("window.__GALAXIAN__.snapshot()");
const target = targetState.enemies.find((e) => e.type === "drone");
await evaluate(`window.__GALAXIAN__.alignPlayer(${target.x}); window.__GALAXIAN__.fire(true);`);
const shotHit = await waitFor("window.__GALAXIAN__.snapshot().score >= 60", 2200);
await evaluate("window.__GALAXIAN__.fire(false)");
const shotState = await evaluate("window.__GALAXIAN__.snapshot()");
check("El proyectil del jugador destruye una nave", shotHit && shotState.score >= 60 && shotState.aliveEnemies < targetState.aliveEnemies,
  { shotHit, score: shotState.score, before: targetState.aliveEnemies, after: shotState.aliveEnemies, target: target.x });

// Ataques autónomos y disparo enemigo.
await evaluate("window.__GALAXIAN__.start(); window.__GALAXIAN__.setInvulnerable(999);");
const autoDive = await waitFor("window.__GALAXIAN__.snapshot().attacking > 0", 8000);
const autoBullets = autoDive && await waitFor("window.__GALAXIAN__.snapshot().enemyBullets > 0", 8000);
const autoState = await evaluate("window.__GALAXIAN__.snapshot()");
check("La IA lanza picadas automáticas y dispara", autoDive && autoBullets && autoState.mode === "playing",
  { autoDive, autoBullets, attacking: autoState.attacking, enemyBullets: autoState.enemyBullets });

// Escuadrón real, multiplicador aéreo y bono máximo.
await evaluate("window.__GALAXIAN__.start()");
await sleep(300);
const raidStarted = await evaluate("window.__GALAXIAN__.forceCommanderRaid()");
await sleep(850);
const raid = await evaluate("window.__GALAXIAN__.snapshot()");
check("Se lanza el Comandante con sus 2 Escoltas", raidStarted && raid.attacking === 3 && raid.squad?.participants.length === 3,
  { attacking: raid.attacking, squad: raid.squad });
check("Los atacantes ejecutan trayectorias fuera de la formación", raid.enemies.filter((e) => e.state === "diving").length >= 3,
  raid.enemies.filter((e) => e.state === "diving").map((e) => ({ type: e.type, progress: e.progress, x: e.x, y: e.y })));
await screenshot("shot-02-dive.png");

const attackState = await evaluate("window.__GALAXIAN__.snapshot()");
const attacker = attackState.enemies.find((e) => e.state === "diving" && e.type === "escort");
const beforeAir = await evaluate("window.__GALAXIAN__.snapshot()");
await evaluate(`window.__GALAXIAN__.killEnemy(${attacker.id})`);
const afterAir = await evaluate("window.__GALAXIAN__.snapshot()");
check("Derribo en picada vale el doble", afterAir.score - beforeAir.score === 200,
  { delta: afterAir.score - beforeAir.score, targetType: attacker.type });

for (const enemy of attackState.squad.participants) {
  await evaluate(`window.__GALAXIAN__.killEnemy(${enemy})`);
}
const afterBonus = await evaluate("window.__GALAXIAN__.snapshot()");
check("El escuadrón completo otorga el bono máximo +1500", afterBonus.score === 2200,
  { score: afterBonus.score, expected: 2200, alive: afterBonus.aliveEnemies });

// Oleadas y progresión.
await evaluate("window.__GALAXIAN__.start()");
await sleep(250);
const wave1 = await evaluate("window.__GALAXIAN__.snapshot()");
await evaluate("window.__GALAXIAN__.clearWave()");
await sleep(600);
const waveClear = await evaluate("window.__GALAXIAN__.snapshot()");
await screenshot("shot-03-wave-clear.png");
await sleep(3700);
const wave2 = await evaluate("window.__GALAXIAN__.snapshot()");
check("La oleada se completa y avanza", wave1.wave === 1 && waveClear.mode === "waveclear" && wave2.wave === 2 && wave2.mode === "playing",
  { wave1: wave1.wave, clearMode: waveClear.mode, wave2: wave2.wave, alive: wave2.aliveEnemies, enemyCount: wave2.totalEnemies });
check("La dificultad aumenta con la oleada", wave2.difficulty.formationSpeed > wave1.difficulty.formationSpeed &&
  wave2.difficulty.diveSpeed > wave1.difficulty.diveSpeed &&
  wave2.difficulty.aggression > wave1.difficulty.aggression,
  { wave1: wave1.difficulty, wave2: wave2.difficulty });

// Daño, vidas y reaparición.
await evaluate("window.__GALAXIAN__.start()");
await sleep(250);
await evaluate("window.__GALAXIAN__.setInvulnerable(0); window.__GALAXIAN__.damagePlayer();");
await sleep(160);
const hit = await evaluate("window.__GALAXIAN__.snapshot()");
await sleep(1750);
const respawn = await evaluate("window.__GALAXIAN__.snapshot()");
check("La colisión resta una vida y reaparece", hit.lives === 2 && hit.player.dead === true && respawn.player.dead === false && respawn.lives === 2,
  { hitLives: hit.lives, hitDead: hit.player.dead, respawnDead: respawn.player.dead, respawnLives: respawn.lives });

// Pausa.
await evaluate("window.__GALAXIAN__.pause()");
await sleep(120);
const paused = await evaluate("window.__GALAXIAN__.snapshot()");
const pauseVisible = await evaluate("getComputedStyle(document.getElementById('pausePanel')).display !== 'none'");
check("La pausa detiene el juego y muestra el panel", paused.mode === "paused" && pauseVisible, { mode: paused.mode, pauseVisible });
await evaluate("window.__GALAXIAN__.resume()");
await sleep(120);
const resumed = await evaluate("window.__GALAXIAN__.snapshot()");
check("Se reanuda la partida", resumed.mode === "playing", resumed.mode);

// Fin de partida y reintento.
await evaluate("window.__GALAXIAN__.start(); window.__GALAXIAN__.setInvulnerable(0); window.__GALAXIAN__.damagePlayer();");
await sleep(1750);
await evaluate("window.__GALAXIAN__.setInvulnerable(0); window.__GALAXIAN__.damagePlayer();");
await sleep(1750);
await evaluate("window.__GALAXIAN__.setInvulnerable(0); window.__GALAXIAN__.damagePlayer();");
await sleep(1800);
const overState = await evaluate("window.__GALAXIAN__.snapshot()");
const overPanel = await evaluate("getComputedStyle(document.getElementById('gameoverPanel')).display !== 'none'");
check("Al perder las 3 vidas aparece el fin de partida", overState.mode === "gameover" && overState.lives === 0 && overPanel,
  { mode: overState.mode, lives: overState.lives, overPanel });
await evaluate("document.getElementById('retryBtn').click()");
await sleep(350);
const retried = await evaluate("window.__GALAXIAN__.snapshot()");
check("El botón de reintento reinicia la partida", retried.mode === "playing" && retried.lives === 3 && retried.score === 0,
  { mode: retried.mode, lives: retried.lives, score: retried.score });

// Captura de juego en escritorio.
await sleep(450);
await screenshot("shot-04-gameplay.png");

// Vista móvil.
await send("Emulation.setDeviceMetricsOverride", {
  width: 430,
  height: 932,
  deviceScaleFactor: 2,
  mobile: true,
  screenOrientation: { type: "portraitPrimary", angle: 0 }
});
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await evaluate("window.dispatchEvent(new Event('resize'))");
await sleep(700);
const mobileLayout = await evaluate(`(() => {
  const all = [...document.querySelectorAll('body *')];
  const widest = all.map(el => ({
    tag: el.tagName, id: el.id, cls: typeof el.className === 'string' ? el.className : '',
    right: Math.round(el.getBoundingClientRect().right), left: Math.round(el.getBoundingClientRect().left),
    width: Math.round(el.getBoundingClientRect().width)
  })).filter(x => x.right > window.innerWidth + 1 || x.left < -1).slice(0, 8);
  return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, widest };
})()`);
const mobileOverflow = mobileLayout.scrollWidth <= mobileLayout.innerWidth + 1;
const touchVisible = await evaluate("getComputedStyle(document.querySelector('.touch-controls')).display !== 'none'");
check("La versión móvil no desborda y muestra controles táctiles", mobileOverflow && touchVisible, { mobileOverflow, touchVisible, mobileLayout });
const mobileFooter = await evaluate(`(() => {
  const f = document.querySelector('footer');
  const r = f.getBoundingClientRect();
  return { text: f.innerText.trim(), top: Math.round(r.top), bottom: Math.round(r.bottom), innerHeight: window.innerHeight };
})()`);
check("El footer exacto sigue visible en móvil",
  mobileFooter.text === "Diseñado por Juan Guillermo Rivera Berrío con tecnología DeepSeek V 4.1" &&
  mobileFooter.bottom <= mobileFooter.innerHeight,
  mobileFooter);
await screenshot("shot-05-mobile.png", true);

// Controles táctiles: el botón derecho desplaza la Galaxip.
await evaluate("window.__GALAXIAN__.start();");
await sleep(250);
const touchStart = await evaluate("window.__GALAXIAN__.snapshot().player.x");
await evaluate(`(() => {
  const b = document.querySelector('[data-control="right"]');
  b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true }));
})()`);
await sleep(650);
await evaluate(`(() => {
  const b = document.querySelector('[data-control="right"]');
  b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true }));
})()`);
await sleep(80);
const touchEnd = await evaluate("window.__GALAXIAN__.snapshot().player.x");
check("El control táctil mueve la Galaxip", touchEnd - touchStart > 60, { before: touchStart, after: touchEnd });

const touchLaneStart = await evaluate("window.__GALAXIAN__.snapshot().player");
await evaluate(`(() => {
  const b = document.querySelector('[data-lane="1"]');
  b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 8, pointerType: 'touch', isPrimary: true }));
  b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 8, pointerType: 'touch', isPrimary: true }));
})()`);
await sleep(420);
const touchLaneHigh = await evaluate(`({
  player: window.__GALAXIAN__.snapshot().player,
  current: document.querySelector('[data-lane="1"]').classList.contains('is-current')
})`);
check("El control táctil sube una línea y la marca como activa",
  touchLaneHigh.player.lane === 1 && Math.abs(touchLaneHigh.player.y - 582) < 0.5 && touchLaneHigh.current,
  { before: touchLaneStart, after: touchLaneHigh });
await screenshot("shot-06-mobile-gameplay.png", true);

// Pantalla de inicio móvil: el botón debe quedar dentro del área visible.
await send("Page.reload", { ignoreCache: true });
await waitFor("document.readyState === 'complete'");
await sleep(1000);
const mobileAttract = await evaluate(`(() => {
  const screen = document.querySelector('.screen').getBoundingClientRect();
  const card = document.querySelector('#attractPanel .overlay-card').getBoundingClientRect();
  const button = document.querySelector('#startBtn').getBoundingClientRect();
  return {
    screen: { top: screen.top, bottom: screen.bottom, height: screen.height },
    card: { top: card.top, bottom: card.bottom, height: card.height },
    button: { top: button.top, bottom: button.bottom, height: button.height },
    inside: button.top >= screen.top && button.bottom <= screen.bottom + 1
  };
})()`);
check("La pantalla de inicio cabe en móvil sin scroll", mobileAttract.inside, mobileAttract);
await screenshot("shot-07-mobile-attract.png", true);

await send("Emulation.setTouchEmulationEnabled", { enabled: false });
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1120,
  deviceScaleFactor: 1,
  mobile: false
});
await evaluate("window.dispatchEvent(new Event('resize'))");
await sleep(300);
await evaluate("window.__GALAXIAN__.start()");
await sleep(600);
await screenshot("shot-08-desktop-wave.png");

// Portátil de 1366×768: el gabinete debe caber sin scroll vertical.
await send("Emulation.setDeviceMetricsOverride", {
  width: 1366,
  height: 768,
  deviceScaleFactor: 1,
  mobile: false
});
await evaluate("window.dispatchEvent(new Event('resize'))");
await sleep(500);
const laptopLayout = await evaluate(`(() => {
  const c = document.querySelector('.cabinet').getBoundingClientRect();
  const f = document.querySelector('footer').getBoundingClientRect();
  return {
    innerHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
    cabinet: { top: Math.round(c.top), bottom: Math.round(c.bottom), height: Math.round(c.height) },
    footerBottom: Math.round(f.bottom)
  };
})()`);
check("Cabe sin scroll vertical en portátil 1366×768",
  laptopLayout.scrollHeight <= laptopLayout.innerHeight + 2 && laptopLayout.footerBottom <= laptopLayout.innerHeight + 1,
  laptopLayout);
await screenshot("shot-09-laptop-1366.png");

// Teléfono compacto de 360 px: inicio, footer y botones de línea visibles.
await send("Emulation.setDeviceMetricsOverride", {
  width: 360,
  height: 740,
  deviceScaleFactor: 2,
  mobile: true,
  screenOrientation: { type: "portraitPrimary", angle: 0 }
});
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Page.reload", { ignoreCache: true });
await waitFor("document.readyState === 'complete'");
await sleep(1000);
const compactMobile = await evaluate(`(() => {
  const screen = document.querySelector('.screen').getBoundingClientRect();
  const button = document.querySelector('#startBtn').getBoundingClientRect();
  const footer = document.querySelector('footer').getBoundingClientRect();
  const lane = document.querySelector('[data-lane="1"]').getBoundingClientRect();
  return {
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    startInside: button.top >= screen.top && button.bottom <= screen.bottom + 1,
    footerBottom: Math.round(footer.bottom),
    footerInside: footer.bottom <= window.innerHeight + 1,
    laneInside: lane.left >= 0 && lane.right <= window.innerWidth + 1,
    laneSize: { width: Math.round(lane.width), height: Math.round(lane.height) }
  };
})()`);
check("Móvil compacto 360×740 sin desbordes y con inicio/línea visibles",
  compactMobile.scrollWidth <= compactMobile.innerWidth + 1 && compactMobile.startInside &&
  compactMobile.footerInside && compactMobile.laneInside,
  compactMobile);

check("Sin errores JavaScript durante la sesión", errors.length === 0, errors);

const summary = {
  passed: results.filter((r) => r.ok).length,
  total: results.length,
  results,
  errors,
  testedAt: new Date().toISOString(),
  viewportDesktop: "1440x1120",
  viewportLaptop: "1366x768",
  viewportMobile: "430x932"
};
fs.writeFileSync(path.join(outDir, "qa-results.json"), JSON.stringify(summary, null, 2));
console.log("\nERRORS", JSON.stringify(errors));
console.log("RESULT", JSON.stringify(summary));
ws.close();
