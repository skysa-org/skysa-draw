# Build history

The product is built in numbered phases, and this is the record of them: what each one delivered and what was learned doing it.
Everything here is shipped unless a line says otherwise.

This is history, so it is not kept current.
Each phase says what was true when it shipped, and a later phase may have replaced it.
For how the app works now, read [`ARCHITECTURE.md`](ARCHITECTURE.md); a `§` here means a section of that file.

## Phase 0 — Scaffold (2026-11-03)
- The repository made from skysa-notes v2.1.1's content-agnostic layers (`decisions/0002-carried-over-from-skysa-notes.md`): the API whole, the provider adapters with their contract tests, the naming and path rules, the PWA and brand build, the tooling and the legal texts.
  Package names `@skysa/draw-core`, `@skysa/draw-web`, `@skysa/draw-api`; the app folder and the IndexedDB database `skysa-draw`; the marker `.drawapp.json`.
- The drawing file decided as SVG with the app's metadata in its own namespace (`decisions/0001-the-drawing-file.md`), and `packages/core/src/drawing/document.ts` written: `isDrawingText`, `readDrawingId`, `withDrawingId`, `readDrawingTitle`, `withDrawingTitle`, `readDrawingSize`, `emptyDrawing`, all over a scanner of the prolog and root tag, with no DOM.
- A fresh D1 schema of two tables, `storage_connections` and `grants`, and its one migration; the API's 423 tests pass against it.
- The web app's store (`store/db.ts`, `drawings.ts`, `folders.ts`, `hooks.ts`): drawings, folders and an op queue in Dexie, each change a transaction over the rows and the queue together, and one pending write per drawing.
- One screen: folders down the side, the open folder's drawings, and the open drawing shown as an image through a `blob:` URL, with rename and delete.
  What is open is in the query, `/?f=<folder>&d=<id>`.
- Not yet: the sync engine (to be ported behind a document-format seam, §10), the connect flow's screens, the editor.

## Phase 1 — Layers, tools and the frame (2026-11-04)
- SVG confirmed as the drawing file; the layer model decided (`decisions/0003-layers.md`): a layer is a direct child of the root, `vector`, `raster` or `group`, SVG's own attributes for what SVG can say and `draw:*` for the rest; `emptyDrawing` writes one empty vector layer; the vocabulary in `packages/core/src/drawing/layers.ts`; `readDrawingProlog` and `conflictStamp` added to core.
- The interface decided (`decisions/0004-the-interface.md`): one component set placed by window size class, the tools users know under the keys they know, Pointer Events only.
- Built by seven agents in parallel against contracts written first (`drawing/document/model.ts`, `drawing/tools/types.ts`, `drawing/types.ts`), then integrated: the component set (`components/ui/`), the document model with DOMPurify, commands and a byte-capped history (`drawing/document/`), select, hand, zoom, pencil, brush, eraser, fill, eyedropper, rectangle, ellipse and line on vector and raster layers, the viewport with gestures and the key map, and the frame with its layers, properties, colour and options panels.
- DOMPurify 3.4 added: the one sanitizer, Apache-2.0 or MPL-2.0. It removes every element outside SVG, XHTML and MathML whatever it is told, so foreign elements are lifted out around it and put back.
- Learned on the way: `outerHTML` of an SVG in the page is HTML serialization and not always XML, so commands keep clones; the DOM Parsing serializer writes an Inkscape root as `<svg:svg>`, which DOMPurify then refuses, so the serializer writes `<svg>`; an SVG `<style>` styles the whole page, so the drawing is mounted in a shadow root; browsers keep Ctrl+Shift+N for a private window, so a new layer is Insert.
- The conflict rule applied in the editor: a drawing changed or deleted elsewhere under unsaved edits keeps the edits as a drawing of their own.
- Tests: core 1016, web over 840, API 423, all under jsdom; nothing yet run in a real browser.

## Phase 2 — The rest of the tools, and the sync engine (2026-11-04)
- The sync engine ported from skysa-notes v2.1.1 into `packages/core/src/sync/` behind a document seam, `sync/document.ts`, with its tests, the store contract and the simulation kit; renamed by two perl scripts written into `decisions/0002-carried-over-from-skysa-notes.md`, so a fix carries both ways; the clipboard and key-file flags and notes' hidden root folders cut.
- The rest of the tools, by six agents against contracts committed first (`RegionControl`, the text host, a stub for each tool and its place in the registry): pen and node over a path-data module of their own (`tools/vector/path/`), text typed in place, the marquee and the lasso and the area every raster tool paints inside, smudge, and crop.
- The layer operations: group and ungroup, clip to the layer below, merge down, rasterize, and an adjustment stack on each layer as SVG filter primitives named in the app's namespace (`decisions/0003-layers.md`, amended).
- Export to PNG, JPEG, WebP and SVG through an `<img>` of a `blob:` URL, and a picture placed from a file, a paste or a drop.
- Learned on the way: the viewport told a tool only about strokes, so a tool with state between strokes (the pen, the text field) watches for itself; `putImageData` ignores a clip, so the fill floods through a coverage mask; no fill rule subtracts one arbitrary path from another, so the area adds and does not subtract.
- Tests: core 7128 (6103 of them the engine's), web 1189, API 423, all under jsdom.
- Then driven in headless Chromium under the real Content-Security-Policy, which raised no violation; it found the layers panel's actions cut off by the dock (a narrow panel's header now puts them on rows of their own), shapes written to every float digit (now two decimals, as paths are), and an open pen path filled into a wedge (now a line in the fill colour).

## Phase 3 — The web sync layer and the connect flow (2026-11-04)
- skysa-notes' web sync layer ported by one agent and its screens by another, at the same time, against a list of the module paths and names the screens import, written down before either began: the Dexie `SyncStore` held to the core contract, the scheduler, the connection, credential, token, account, relay and API clients, export as a zip of `.svg` files, and the sources and account panels on this app's own components.
- Schema version 1 rewritten in place, since it had never shipped: drawings keyed by connection and id, a deleted drawing a tombstone until its delete is pushed, and the tables for the credential, the sync state and the files beside a drawing.
- `saveDrawing` became a compare-and-set, and the editor counts a save still in flight as unsaved, so a change that arrives meanwhile keeps the edits as a copy.
- Tests: core 7128, web 2352, API 423; the largest chunk grew from 121 kB to 210 kB of its 350 kB budget, the sync layer loading with the app.

