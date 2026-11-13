---
'@skysa/draw-web': patch
---

The open drawing's edits are written before anything acts on what the device holds: a newer version of the app closing this window's database, a disconnect, a source let go, or an export.
Until now a drawing's last half-second of strokes could be left out, or lost when another window updated the app.
A window a newer version has closed now says so over the whole window, and stops taking strokes or keys it cannot save.
It can be put aside to export the drawing first.
A window waiting for an older one to let go says that too, instead of hanging.
The browser is asked to keep the drawings when the first is made on a device with nothing connected, and again when the app is installed, so Safari or Chromium does not clear a library that exists nowhere else.
