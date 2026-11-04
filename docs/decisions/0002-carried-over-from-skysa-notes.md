# 0002. Carried over from skysa-notes

*2026-11-03. Cited in the code as §12, "Carried over from skysa-notes". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**This repository began as a copy of every layer of skysa-notes that does not care what a file holds, and records where each piece came from.**
The two apps are to be used the same way by the same parent project: a cloud deployment consumes each as a git submodule, calls its `createApp`, hands it an `EntitlementProvider`, a `RateLimiter` and a relay, and builds its web app with its own `DRAW_BRAND` (§13).
Each product therefore has to export its own API and its own core, and the question was whether the shared parts should be a package the two depend on, a submodule, or a copy.

A copy was chosen, with provenance written down here, for now.
A shared package would be the right end state and the wrong first step: the seam between what is shared and what is notes' own was not yet known when this repository was made, and cutting it in one go would have moved the notes app's code about before anything of the drawing app existed to say what it needs.
A submodule of the notes repository would bring every notes-only module along and tie the drawing app's version to the notes app's.
A copy let the drawing app start from code that passes its tests, with the parts that proved content-specific cut away by hand and the cut recorded.

What came across, from skysa-notes v2.1.1 (`b39c8e42f542bdc9f222d5d536bb490710ec3cdc`):

| Layer | What | Changed on the way |
|---|---|---|
| `apps/api` | The whole Worker: the connect flow, per-connection credentials, `POST /api/token`, the connection and grant routes, the change relay, the D1 shim for tests | Fresh schema and one migration, without the `users` and `identities` tables notes kept for a sign-in it dropped; comments say drawings |
| `packages/core/src/providers` | The adapter interface, the Dropbox, OneDrive and Google Drive adapters, the in-memory fake, the contract tests and wire stubs | `.md` became `.svg` and `text/markdown` became `image/svg+xml` where an adapter names the app's own file type |
| `packages/core/src/names` | Folding, extensions, slugs, conflict names, byte caps | The slug's byte cap is 215, not 216, for a four-byte extension; tags and the title helpers for markdown were left behind |
| `packages/core/src/{paths,marker,hash,json,cell,api,relay,entitlements,files}` | Paths, the marker file, hashing, the API's shared constants, the relay protocol, the operator seams' types, media types and picture headers | The hidden-folder rule lost the two root exceptions notes made for its scratchpad and vault |
| `apps/web` build | `brand.ts`, `pwa.ts`, `vite.config.ts`, `_headers`, the bundle budget, the PWA, CSP and brand tests | No share target and no second page |
| `apps/web/src/i18n` | The catalog machinery and its tests | An English catalog of this app's own words |
| `apps/web/src/sync/providers.ts` | The provider factory with its request deadlines | Nothing |
| Root | ESLint, Prettier, knip, tsconfig, Changesets, CI, the legal texts | Lint layers for this app's folders; no bookmarklet |

What did not come across, and why:
the sync engine (`packages/core/src/sync`), because it is coupled to notes in two places — the conflict copy patches a frontmatter `id`, and the pull batch reads a note's identity with `parseNoteFile` — and the right move is to port it behind a document-format seam once the drawing's own identity rules exist, which they now do (`readDrawingId`, `withDrawingId`; §10);
the markdown pipeline, the editors, the clipboard, the scratchpad, the vault, secrets and the bookmarklet, which are the notes app;
the web app's store, sync runtime and screens, which read notes' rows, and are written afresh here over the same shape of database so the engine port finds what it expects (§7).

Until a shared package exists, a fix to a carried-over layer is a fix in both repositories.
The trigger for extracting the package is the first change that has to be made twice: when that happens, the shared layers move to a package the two products depend on, and this record says so.
