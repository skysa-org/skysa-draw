# 0005. On the kit

*2026-11-13. Supersedes [0002](0002-carried-over-from-skysa-notes.md), and §12, "Carried over from skysa-notes", cites it first. A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**The layers this app took from skysa-notes are the shared kit's now, [skysa-org/skysa-kit](https://github.com/skysa-org/skysa-kit), and this app depends on its packages at one exact version; its drawing file, its names, its database and its screens are its own.**
Record 0002 copied every layer of skysa-notes that does not care what a file holds, and named the trigger for a shared package: the first change that has to be made twice.
Memoriam, a third app on the same layers, passed it first, carrying skysa-notes' later fixes by hand; and the three copies no longer matched letter for letter, this one respelled, so a fix had stopped being a patch that applies in three places.
[skysa-notes' record 0018](https://github.com/skysa-org/skysa-notes/blob/main/docs/decisions/0018-the-shared-kit.md) made the kit: seven packages with one version between them, AGPL-3.0-only under the same CLA as this repository, published to npm from a tag.
Its step 4 was this app, and the question was how a copy taken before the kit's seams existed comes to depend on it without changing anything a user holds.

It was a swap, not a merge.
The kit's seams were cut with this app in view: its `DocumentFormat` is what `sync/document.ts` was here, and its `AppFolderSpec` takes what `config.ts` held.
When skysa-notes checked the forks' fixes before the kit was cut (skysa-notes #700), this app had no fix to a shared layer that skysa-notes lacked, so nothing here had to go to the kit first.
The kit's ports call a document a note (`SyncNote`, `noteId`, the `*-note` change kinds) and a folder a folder; this app uses the kit's names where it implements a port and where it reads what the kit hands back (a stuck push's `noteId`), and maps them there to its own rows, so its database did not change.

What went where, at kit 1.1.0:

| Was here | Is the kit's |
|---|---|
| `apps/api/src` but `worker.ts`, its tests but the Worker's own and the migrations', the migrations | `@skysa/server` (#5) |
| The protocol: `api.ts`, `relay.ts`, `entitlements.ts`, the provider kinds | `@skysa/protocol` (#8) |
| The adapters, the naming and path rules but the slug and this app's own names, the marker, hashing, `json`, `cell`, `bytes`, the media types and the attachments' names | `@skysa/storage` (#8) |
| The sync engine, its store contract and its simulation kit; not the document seam, which is `DRAW_FORMAT` now | `@skysa/sync` (#8) |
| The web app's API client and instance config, tokens, providers, relay, scheduler, progress, wake lock, the hand-off before an update (`beforeUpdate`, now `makeWay`), credentials, connect code and emitter | `@skysa/client` (#8) |
| `brand.ts`, `pwa.ts` and the bundle budget's script | `@skysa/pwa` (#6) |
| The shared lint rules, the compiler's settings and Prettier's | `@skysa/eslint-config` (#7) |

The table names the layers; the pull requests list every file.
Some files were made on the way, to hand the kit what is this app's: among them `apps/web/pwaApp.ts` (#6), `drawing/format.ts`, `names/drawings.ts` and the `sync/` files named below (#8); and `apps/api/src/index.ts` and `relay.ts`, which pass on the server's names (#5).
What stays this app's: the drawing file and its layers (`drawing/`), the names it gives its files (`names/`, the slug's 215-byte cap among them), the pictures, the Dexie schema and the store over it, the editor, the screens and the catalog.
What it hands the kit:

- `DRAW_FORMAT` (`drawing/format.ts`), the format: `.svg`, `image/svg+xml`, the `draw:id` a file claims, a conflict copy's contents, and a `.svg` that is not an SVG document held as unreadable.
- `DRAW_FOLDER` (`config.ts`), the folder: `skysa-draw`, Drive's tag `drawapp`, and the marker `.drawapp.json` naming `skysa-draw` at version 1.
- Its database, as the client's ports (`sync/dexiePorts.ts`, which `sync/drawingsSync.ts` hands the kit's scheduler), as the engine's `SyncStore` (`sync/store.ts`), and as the `CredentialStore` every client call that reads a credential takes (the database itself, for its `credentials` table); and the lock it has always taken, by the same name (`sync/lock.ts`).
- Its own lint blocks, which `eslint.config.js` passes to the kit's `skysa()`.

Nothing a user holds changed: the folder, the marker and the tag, `.svg` and its media type, a conflict copy's name, the lock `skysa-draw:sync:<id>`, and the database's name and version.
`packages/core/tests/folderSpec.test.ts` reads and writes the marker 0.1.0 wrote, byte for byte.
The server's database is the one thing that does not carry over as it is.
The kit's migrations make the same two tables this app's one migration did, but that migration had the name of the kit's first, so wrangler takes the kit's first as applied, and a database migrated as it is fails at the kit's second.
A 0.1.0 database is reset onto the kit's migrations rather than marked as having applied them (decided 2026-11-12): it holds connections and nothing else, no drawing is touched, and each device connects again.
[`self-hosting.md`](../self-hosting.md), "A database from 0.1.0", says how and what goes with it, and `apps/api/tests/migrations.test.ts` runs the reset as it gives it.

The move was rehearsed whole first, in a tree never pushed, against kit 1.0.0, and the gaps it found were the kit's to close: `conflictStamp` exported (skysa-kit#14), and a device in the kit's test suites that writes a document as the app does (skysa-kit#15).
Two more came from this app's build: a brand plugin named after skysa-notes (skysa-kit#16), and a description with an `&` escaped twice in the page (skysa-kit#17).
The four are kit 1.1.0.
Each pull request then held to the same checks: every test this app ran before is still here or in the kit, matched by title with the kit's words read as this app's; the built manifest is the same bytes; the bundle is within its budget; and, for the lint, every file's effective config was compared with main's and this app's own rules were shown still to fire.
Storage, the engine and the client went in one pull request, #8, not the two planned, since this app's scheduler predated the seams the kit's engine has.

From here, a fix to a shared layer is a kit pull request, and this app takes it by moving its pin, on purpose, with a changeset; `apps/web/tests/kitVersion.test.ts` holds every manifest to one version of the kit.
The perl scripts in record 0002 are not how a fix travels any more.
A layer two apps grow alike is a candidate for the kit; one only this app has stays here.
