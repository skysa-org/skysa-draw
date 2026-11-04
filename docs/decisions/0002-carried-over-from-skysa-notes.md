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
| `packages/core/src/sync`, `tests/sync` | The sync engine, its store port, the store contract, the in-memory store, the simulation kit, the two-device and random-remote tests (2026-11-04) | The rename below; `sync/conflicts.ts` became `sync/document.ts`, the document seam; the clipboard and key-file flags cut; `messageOf` from `errors.ts`; fixtures are SVG (`tests/sync/kit/drawings.ts`) |
| `apps/web/src/sync/providers.ts` | The provider factory with its request deadlines | Nothing |
| `apps/web/src/{store,sync,api,errors,hooks}`, their tests | The Dexie store, the `SyncStore`, the scheduler, the connection, credential, token, account, relay and API clients, the connect code, export, held edits, stale and frozen tabs (2026-11-04) | The rename; schema version 1 rewritten in place without the clipboard, picture and key tables; cut: clipboard, key file, secrets, vault, scratchpad, pictures, pins, open folders, recents, last open, per-source prefs, search, frontmatter, file links and the attachment writers, import and zip reading, editor mode, code display, slices; the lock is `skysa-draw:sync:<id>`; notes' issue numbers in comments read "skysa-notes #N" |
| `apps/web/src/components/{account,sources}`, their tests | The account panel, the sources, the connect choice, button and code, the devices, disconnecting and moving what was never sent (2026-11-04) | Drawn on this app's component set; one sources panel at every size in place of notes' tabs and gear menu; questions and info sheets on `Panel`; the app's own provider marks, since notes ships the vendors' trademarks; cut: importing, the clipboard and scratchpad toggles, secrets and the key file |
| Root | ESLint, Prettier, knip, tsconfig, Changesets, CI, the legal texts | Lint layers for this app's folders; no bookmarklet |

The sync engine came across a day after the rest, once the drawing's own identity rules existed (`readDrawingId`, `withDrawingId`): notes' engine read a note in two places, the conflict copy patching a frontmatter `id` and the pull batch reading a note's identity with `parseNoteFile`, and both now go through one module, the document seam (§7, "Sync engine").

A file carried from skysa-notes is renamed by two scripts, run in order, so a fix made in one repository is carried to the other by the same.
They are perl, not sed, since BSD sed has no lookarounds.
The first renames the domain word, "notebook" to "folder" before "note" to "drawing", so a notebook does not become a drawingbook:

```sh
perl -pi -e 's/skysa-notes/\x01/g; s/(?<![A-Za-z])notebooks(?![a-z])/folders/g; s/(?<![A-Za-z])notebook(?![a-z])/folder/g; s/(?<![A-Z])Notebooks(?![a-z])/Folders/g; s/(?<![A-Z])Notebook(?![a-z])/Folder/g; s/(?<![A-Za-z])NOTEBOOKS(?![A-Z])/FOLDERS/g; s/(?<![A-Za-z])notes(?![a-z])/drawings/g; s/(?<![A-Za-z])note(?![a-z])/drawing/g; s/(?<![A-Z])Notes(?![a-z])/Drawings/g; s/(?<![A-Z])Note(?![a-z])/Drawing/g; s/(?<![A-Za-z])NOTES(?![A-Z])/DRAWINGS/g; s/(?<![A-Za-z])NOTE(?![A-Z])/DRAWING/g; s/\x01/skysa-notes/g'
```

The second renames the file format and the package:

```sh
perl -pi -e 's/(?<![A-Z])(ARCHITECTURE|CLAUDE|README)\.md/$1\x01/g; s/\.md(?![A-Za-z0-9])/.svg/g; s/\.MD(?![A-Za-z0-9])/.SVG/g; s/\x01/.md/g; s{text/markdown}{image/svg+xml}g; s/\.notesapp\.json/.drawapp.json/g; s{\@skysa/core}{\@skysa/draw-core}g'
```

The engine's test fixtures take a third, which makes each string or template literal ending in a line break, other than a bare one or one inside `encode(`, an SVG, `svg(…)` from `tests/sync/kit/drawings.ts`; as a perl script, since it quotes both quote marks:

```perl
s/(?<!encode\()(?<!svg\()'((?:[^'\\\n]|\\.)+?\\n)'/svg('$1')/g;
s/(?<!encode\()(?<!svg\()`((?:[^`\\\n]|\\.)+?\\n)`/svg(`$1`)/g;
```

What did not come across, and why:
the markdown pipeline, the clipboard, the scratchpad, the vault, secrets and the bookmarklet, which are the notes app;
the editors, the list and the library's rows, which are this app's own.

Until a shared package exists, a fix to a carried-over layer is a fix in both repositories.
The trigger for extracting the package is the first change that has to be made twice: when that happens, the shared layers move to a package the two products depend on, and this record says so.
