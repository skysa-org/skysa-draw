---
'@skysa/draw-web': patch
---

When a new version takes over, every window of the app writes what its open drawing holds before it reloads, the last half-second of strokes among it, which the reload took with it until now.
A drawing whose page is hidden, as when a phone switches to another app, writes a stroke still being finished as well as the ones before it.
