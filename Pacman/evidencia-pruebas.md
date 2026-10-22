# Evidencia de pruebas — Pac-Man Neón

Archivo evaluado: `pacman.html`

## Comprobaciones automáticas ejecutadas en Chrome headless

- Carga inicial: estado `intro`, 248 puntos en el laberinto, 3 vidas, nivel 1.
- Inicio con `Enter`: pasa a `playing`; Pac-Man avanza y la puntuación aumenta al comer puntos.
- Reversa con teclado: el vector de dirección cambia de izquierda a derecha en plena partida.
- Pausa con `P`: estado `paused`, overlay visible; al pulsar `P` de nuevo vuelve a `playing`.
- Píldora de energía: `frightTimer` activo y fantasmas en estado asustado.
- Fantasma asustado: al contacto se marca `eaten`, suma +200 y la puntuación sube.
- Contacto mortal: estado `dying`, animación y posterior decremento de vida (3 → 2).
- Reinicio tras muerte: se conservan los puntos comidos y se vuelve a `ready` sin reiniciar el nivel.
- Túnel: al salir por el borde izquierdo de la fila 14, Pac-Man reaparece por la derecha y continúa.
- Puerta de la casa fantasma: un fantasma normal colocado frente a la puerta no atraviesa; sigue su ruta por el laberinto.
- Nivel completado: estado `levelclear`, bonus +1000; después pasa a nivel 2 con 248 puntos restaurados.
- Game over: overlay final con puntuación y récord; `Enter` inicia una partida nueva con 3 vidas.
- Vista móvil de 390 px: sin desbordamiento horizontal y controles táctiles visibles.
- Consola del navegador: 0 excepciones y 0 errores.

## Capturas

- `shot-start.png`: pantalla de inicio.
- `shot-playing.png`: partida en curso.
- `shot-power.png`: modo asustado y barra de energía.
- `shot-levelclear.png`: nivel completado.
- `shot-gameover-desktop.png`: game over.
- `shot-mobile.png`: diseño móvil.
- `shot-final.png`: partida final de humo.

Los scripts `test-pacman.mjs`, `test-extra.mjs`, `test-final.mjs` y `test-smoke.mjs` reproducen las comprobaciones contra Chrome con depuración remota en el puerto 9333.
