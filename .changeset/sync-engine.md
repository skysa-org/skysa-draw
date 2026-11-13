---
'@skysa/draw-core': minor
---

Sync, on the shared kit's engine (`@skysa/sync` 1.1.0, skysa-notes' record 0018, step 4) behind this app's document format (docs/ARCHITECTURE.md §7, "Sync engine"): `DRAW_FORMAT`, which reads the `draw:id` a drawing carries and builds its conflict copy (`conflictContent`), and `DRAW_FOLDER`, the folder, marker and Drive tag the kit's adapters keep, as 0.1.0 named them.
A `.svg` that is not an SVG document is listed as unreadable and never rewritten.
The test doubles are the kit's: `@skysa/storage/testing`, `@skysa/sync/testing` and `@skysa/client/testing`.
