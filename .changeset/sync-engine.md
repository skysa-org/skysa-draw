---
'@skysa/draw-core': minor
---

The sync engine, ported from skysa-notes v2.1.1 behind a document-format seam (docs/ARCHITECTURE.md §7, "Sync engine"): `createSyncEngine`, the `SyncStore` port and its types, `conflictContent` and `isFileChange`.
A `.svg` that is not an SVG document is listed as unreadable and never rewritten.
The store contract and the in-memory store are `@skysa/draw-core/testing`.
