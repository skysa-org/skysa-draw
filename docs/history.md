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
