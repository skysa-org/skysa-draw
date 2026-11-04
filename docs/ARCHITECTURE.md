# skysa-draw — Architecture and decisions

This file is the source of truth for how the app works and why.
It is kept current: when a decision changes, this file changes in the same pull request, and the record of the decision in [`decisions/`](decisions/) with it.
[`history.md`](history.md) is how the app was built, phase by phase, and is not kept current.
Open work is in GitHub issues.

A `§` in the code or the records means a section of this file.
Where a section says "see the record", the record holds the whole reasoning and this file holds the decision.

The repository started as a copy of the content-agnostic layers of [skysa-notes](https://github.com/skysa-org/skysa-notes), whose architecture document this one follows section for section, so that a reader of either finds the other familiar (§12).

## 1. Core decisions (settled)

| Decision | Choice | Why |
|---|---|---|
| What a drawing is | One SVG file, `name.svg`, with the app's metadata in its own XML namespace on the root element (§3; `decisions/0001-the-drawing-file.md`) | Every browser renders it, every vector tool opens it, and it has room for the app's own data without hiding it |
| Where drawings live | An app-owned folder on the user's own Google Drive, OneDrive or Dropbox, as an ordinary directory tree | The user's data in the user's storage, readable by any other tool |
| Where the app runs from | IndexedDB, first and always; sync is layered on top (§7) | Works offline; renders before any network call |
| What the server holds | Encrypted refresh tokens and connection metadata, nothing else (§6) | No drawing content ever reaches it, so a compromise of it is not a compromise of the drawings |
| Identity | None: each connected account is its own silo, reached by a credential the device holds (§6) | Identity and storage coupled on purpose; no sign-in, no `users` table |
| Conflicts | Remote keeps the path; local is written beside it as `<name> (conflict <timestamp>).svg` (§7) | Never lose user data |
| The editor | SVG in the DOM, through a sanitizer, edited with pointer events; raster content as `<image>` elements (§7, "The editor") | The file is the document; the editor is a view over it |
| Files from elsewhere | Shown as the browser renders them; given an id on the way in, otherwise untouched (§3) | What the editor does not know is kept, never dropped |
| Deployment | One Cloudflare Worker serves the SPA and `/api`; D1 for the database; self-hostable end to end (`self-hosting.md`) | One origin, first-party cookies, free tier enough for one person |
| What an operator can change | The `EntitlementProvider`, `RateLimiter` and relay seams of `createApp`, the env flags, and the `DRAW_BRAND` build input (§8, §13) | No deployment-specific code in the repository |
| Licence | AGPL-3.0-only, with a CLA (§13) | Same as skysa-notes |
| Relationship to skysa-notes | A copy of its content-agnostic layers, with provenance (§12; `decisions/0002-carried-over-from-skysa-notes.md`) | Each product exports its own API and core to the parent project; a shared package comes when the first fix has to be made twice |

## 2. Architecture overview

Three packages in a pnpm workspace, one version between them (`.changeset/README.md`):

- `packages/core` — framework-free TypeScript that runs in the browser, in Node and in Workers: the drawing file's rules (§3), paths and names, the provider adapter interface and the three adapters (§4, §5), the marker file, the relay protocol and the types an operator's policy is written against.
  It imports nothing from `apps/*` and nothing of Node or the DOM; ESLint and a second `tsc` pass with no Node types keep it so.
- `apps/web` — the PWA: Vite, React, TanStack Router, Dexie over IndexedDB, vite-plugin-pwa.
  It boots and renders from IndexedDB, talks to the providers directly from the browser for drawing content, and to `apps/api` only to connect an account and to mint access tokens.
- `apps/api` — a Hono app on Cloudflare Workers with D1 through Drizzle: the storage OAuth flows, per-connection credentials, token minting, the connection and device routes, and the optional change relay (§6).
  Only `src/worker.ts` reads the environment; everything else takes its configuration and its seams through `createApp(options)`.

Data flows:

```
browser ──(SVG, bytes)──▶ Google Drive / OneDrive / Dropbox      the drawings
browser ──(credential hash)──▶ apps/api ──(refresh token)──▶ provider token endpoint
                                   └─▶ D1: storage_connections, grants
```

A drawing never passes through `apps/api`.
The Worker is in the picture when an account is connected (an OAuth redirect) and when an access token is needed (`POST /api/token`), and, where the operator turns the relay on, to tell a connection's other devices that something changed.

## 3. The drawing file and directory layout

### The drawing file

Decided 2026-11-03; see [`decisions/0001-the-drawing-file.md`](decisions/0001-the-drawing-file.md).
A drawing is one `.svg` file, and the app's own metadata rides inside it in a namespace of its own, `https://skysa.org/draw/1`, on the root element.

What the app writes on "new drawing" (`emptyDrawing`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:draw="https://skysa.org/draw/1" draw:id="7f1b8c2e-…" viewBox="0 0 1600 1000" width="1600" height="1000">
  <title>Floor plan</title>
</svg>
```

- `draw:id` is the drawing's identity: a UUID given once and never changed, so a rename or a move on one device is the same drawing to another, and a file copied between two accounts is the same drawing in each.
  The attribute's prefix is whatever the file binds the namespace to; `draw` is what this app writes when the file has none.
- `<title>`, the first child of the root, is the drawing's title, which other tools show.
  The filename is the title's slug (`drawingFilename`), kept unique in its folder (`uniqueFilename`); where a file has no title, its name is its filename's stem (`titleFromFilename`).
- `viewBox` is the canvas; `width` and `height` beside it say the same in user units for tools that read only those.
  A file with neither is shown at a size of the app's choosing (`readDrawingSize`, `DEFAULT_DRAWING_SIZE`).
- The namespace's version is its URL.
  A later shape of the metadata is a new namespace, and an old build can tell it does not know it.

Core reads and writes all of this without a DOM (`packages/core/src/drawing/document.ts`): a scanner over the prolog and the root's start tag, and the first `<title>` after them, so it runs in Workers and Node, and reads only the start of a file however large the drawing is.
`withDrawingId` and `withDrawingTitle` rewrite the one tag or element they are about and keep every other byte, so a file given its id twice is the same bytes, and a file from Inkscape keeps its comments and its doctype.

What the body holds is the editor's business (§7, "The editor"), with these rules:

- Vector content is SVG's own elements, as any tool writes them.
- Raster content is `<image>` elements: small ones inline as `data:` URLs, large ones as files beside the drawing referenced by a relative `href`, named by their content (`attachmentName`: `photo-3f9a1c2b.jpg`), so the same picture placed twice is one file.
- Adjustments are SVG filters, masks and clip paths, so they stay editable and a flattened export is a render.
- Nothing is dropped.
  An element the editor does not know is kept where it was and shown as the browser renders it.

Any `.svg` whose root is an `svg` element in the SVG namespace is a drawing to this app (`isDrawingText`), including one another tool made; one with no id is given one on the way in.
A `.svg` that is not that — a file misnamed, or one that will not decode as UTF-8 — is left alone and shown as unreadable, never rewritten (`UnreadableError`, §4).

### Directory layout

The app owns one folder on the provider, `skysa-draw` (`APP_FOLDER_NAME`), created on first connect, with a marker file at its root:

```
skysa-draw/
  .drawapp.json                   the marker: app name, schema version, who made it
  Floor plan.svg                  a drawing at the root
  Work/
    logo.svg
    logo-2.svg                    a second drawing titled "Logo", disambiguated as a file manager would
    photo-3f9a1c2b.jpg            a raster placed in a drawing, named by its content
    Sketches/
      plan.svg
```

- Paths are POSIX, relative to the app folder, and never begin or end with a separator; the root is the empty string (`paths.ts`).
- Folders are the user's folders, named as typed less what breaks a path (`sanitizeFolderName`), unique in their parent however they are cased (`foldName`).
- Anything under a dot-prefixed segment is hidden from the UI and passed over by sync (`isHidden`): the marker, a provider's bookkeeping, a `.DS_Store`.
  Unlike skysa-notes, there are no exceptions at the root.
- Names are capped so that one conflict suffix always fits in the 255 bytes a filesystem allows (`names/bytes.ts`, `names/slug.ts`): a slug is at most 120 code points and 215 bytes, which leaves room for ` (conflict 2026-09-15T14-32)`, `.svg` and two counters.
- A conflict copy is `name (conflict 2026-09-15T14-32).svg` beside the original, UTC to the minute, with `-2`, `-3` for a second one in the same minute (`names/conflicts.ts`).
  A file that is not a drawing keeps its own extension: `photo (conflict …).jpg`.

The marker (`marker.ts`) carries `MARKER_SCHEMA_VERSION`; a client that finds a higher one opens the connection read-only rather than writing a layout it does not understand.

## 4. Provider adapter interface

`StorageProvider` in `packages/core/src/providers/types.ts`, carried over from skysa-notes without change but for the words.
Every adapter passes `tests/providers/contract.test.ts` (`describeProviderContract`), which runs the same suite over the in-memory fake and over each real adapter against a stub of its wire protocol.

```
ensureRoot()                      the app folder, made if missing, the marker written if absent
list(folderPath)                  one folder's entries
read(entry)                       a drawing's text, decoded strictly as UTF-8, and its version
write(path, content, { expectedVersion })   a drawing's text, conditional on the version
readBytes(entry)                  any file's bytes as stored, never decoded
createFile(path, bytes, { contentType })    create-only, for a file that is not a drawing
createFolder(path)
move(entry, newPath)
delete(entry)
changes(cursor?)                  what changed since the cursor; none means a full scan
```

- `read` and `write` are for the app's own document, text; `readBytes` and `createFile` are for everything else, bytes.
  A drawing that will not decode, or holds a NUL, is an `UnreadableError`: shown, never pushed over (`providers/text.ts`).
- Errors carry a `code` the engine acts on: `ConflictError` (the version moved), `AuthError` (token refused), `NotFoundError`, `CursorResetError` (start a scan), `RateLimitError` (with `retryAfterMs`), `UnreadableError`.
  Anything else is retried and counted against the op.
- `listsEverything` is false on Google Drive, whose `drive.file` scope shows the app only what it made; the engine then never deletes a folder on the strength of a listing, and marks it left instead (`leaveFolder`).
- `writesAtOnce` is how many writes a push may send together: four on Google Drive, one elsewhere.
- Paths above this line are the app's; each adapter converts to its own convention at its edge — ids on Google Drive and OneDrive through `idTree.ts`, paths on Dropbox.

## 5. Provider specifics

Carried over whole; each adapter's file says what it learnt of its provider, with the vendor's URL beside each claim.
The short version:

### 5.1 Google Drive
`drive.file` scope, the folder found by an `appProperties` tag (`drawapp=root`) rather than by name, so a rename keeps it.
Writes go by id; a file is three or four requests end to end, so a push sends four at once.
Two items at one path, which Drive allows and a path cannot hold, are separated by renaming the later one as a conflict copy (`duplicates.ts`); a duplicate file with the same bytes that is not a drawing is dropped as the same file.
Changes come from the changes feed; a feed that runs longer than twice a scan is reset and the round scans.
A drawing is uploaded as `image/svg+xml; charset=UTF-8`.
Registration: `google-oauth.md`.

### 5.2 OneDrive (Microsoft Graph)
The app folder (`approot`), everything in it visible.
File bytes come from a pre-authenticated download URL on a host that is not Graph, which the CSP's `connect-src` lists (§9).
eTags for versions; a delta feed for changes.

### 5.3 Dropbox
The app folder, everything in it visible, path-based.
`rev` for versions; a cursor over `list_folder/continue` for changes.
One write at a time: Dropbox locks the namespace per write and answers `429` to contention.

### 5.4 WebDAV
Deferred indefinitely, as in skysa-notes: it needs a proxy on the Worker, which would stream content through the server this architecture keeps content away from.
`PROVIDER_KINDS` lists it so a deployment's policy can name it; nothing else does.

## 6. Backend

Carried over whole from skysa-notes (§12); the words here are the decisions, and the code's comments the detail.

**No identity.**
A connection is one storage account, reached by the devices that hold a credential for it.
Nothing aggregates connections under a person, and there is no sign-in.
The schema has two tables and is new: skysa-notes' `users` and `identities`, kept there for a sign-in it dropped, were not carried over.

**Storage OAuth.**
Hand-rolled over Web Crypto, no dependency.
`POST /api/auth/connect/:provider/start` (same origin, with the device's credential hash, the return path and an operator's code where one is asked) sets a `__Host-` flow cookie with `state` and a PKCE verifier and redirects to the provider; `GET …/callback` exchanges the code, asks the provider who the account is, upserts the connection on `(provider, account_id)`, writes the device's grant, and redirects back to the app with `?connect=ok` or a reason.
Refresh tokens are sealed with AES-256-GCM under `SECRETS_KEY` and never leave D1 decrypted except inside `POST /api/token`.

**Per-connection credentials.**
The device generates 32 random bytes (`sk1_…`), keeps them in IndexedDB, and sends only their SHA-256.
`grants.secret_hash` is unique over every row, tombstones included: revoking a device nulls its `connection_id` and keeps the row, so a hash that has ever been used can never be claimed again, and a credential leaked from a dump mints nothing.
`grants.last_used_at` is touched at most once a day for idle expiry; `grants.device` is the browser's own label of itself.

**Data model (Drizzle, D1).**
`storage_connections` (`id`, `provider`, `account_id`, `display_name`, `root_id`, the sealed secret and its key id, timestamps; unique on `(provider, account_id)`) and `grants` (`id`, `connection_id` → set null, `secret_hash` unique, `created_at`, `last_used_at`, `device`).
One migration, `0000_init.sql`, generated by `drizzle-kit` from `src/db/schema.ts`; CI regenerates and compares.

**Endpoints**, all under `/api`:

| Route | Guard | What |
|---|---|---|
| `GET /health` | — | `{ ok: true }` |
| `GET /config` | — | What this deployment offers: the providers enabled, whether the relay is on |
| `POST /auth/connect/:provider/start` | same origin | Begin connecting an account |
| `POST /connect-code` | same origin | Check an operator's code before connecting (`EntitlementProvider`) |
| `GET /auth/connect/:provider/callback` | flow cookie | Finish connecting; upsert the connection and the grant |
| `POST /token` | credential | A short-lived provider access token for the connection |
| `GET /connection` | credential | The connection's metadata |
| `GET /connection/grants` | credential | The devices holding a grant |
| `DELETE /connection/grants/:id` | credential | Revoke a device |
| `DELETE /connection` | credential | Disconnect the account; its grants become tombstones |
| `POST /connection/relay/ticket` | credential | A one-time ticket for the relay socket |
| `GET /relay` | same origin, ticket | The change relay's WebSocket |

Every response is `Cache-Control: no-store`; `hono/csrf` guards the same-origin routes; the Worker runs without `nodejs_compat`.

**Seams.**
`createApp({ config, entitlements, rateLimiter, relay, fetch, providerTimeoutMs })`.
`entitlements` decides whether an account may connect and why not (`ENTITLEMENT_CODES`); `rateLimiter` decides whether a request may proceed; `relay` is the change relay's hub.
The defaults allow everything and limit nothing.
A parent project supplies its own and never edits this repository (§13).

**Change relay** (optional, `RELAY=true`).
A Durable Object per connection, `ConnectionRelay`, which a device tells "I pushed" over a WebSocket and which tells the connection's other devices "something changed", nothing else.
Declared in `wrangler.toml` whether or not it is on; `self-hosting.md` says what it costs.

## 7. Local store and sync engine (client)

### IndexedDB schema (Dexie)

`apps/web/src/store/db.ts`, database `skysa-draw`, version 1:

```
drawings   id, [connectionId+path], [connectionId+dirty], updatedAt
folders    id, [connectionId+path]
opQueue    ++id, connectionId, drawingId
prefs      key
```

- A `DrawingRecord` holds the SVG text whole, its title, its path, its `contentHash`, the `syncedHash` it last agreed on with the provider, the provider's `remoteId` and `remoteVersion`, and `dirty` as 0/1 (IndexedDB cannot index a boolean).
- Until an account is connected every row belongs to the `local` connection; attaching a real one is a data migration, not a schema change.
- The database's name is data identity and not brand: a deployment that renames the app keeps it (§8).
- A later version adds a `version(n).stores()` with an `upgrade()` and never edits an earlier one.
  The shape follows skysa-notes' store, so the sync engine ported from it finds what it expects.

### What the app does to drawings

`store/drawings.ts` and `store/folders.ts`: each change is one transaction over the rows and the op queue together, so the queue never says something the rows do not.

- `createDrawing`: an empty canvas, or text brought in from a file, given this app's id if it has none; its filename the title's slug, unique in the folder; a `create` queued.
- `saveDrawing`: the editor's text, with the drawing's own id written in whatever the text carried; a save of the same text is ignored; one `write` waits per drawing however many saves come, and the push sends what the row holds then.
  The hash is computed before the transaction opens: Web Crypto is a wait IndexedDB does not hold a transaction across.
- `renameDrawing`: into the file's `<title>` and into the filename; a `move` queued where the name changed, and a `write`.
- `deleteDrawing`: the row gone now; a `delete` queued where the provider holds the file, and everything queued for a drawing it never saw dropped.
- `createFolder`: refused where the parent has the name however it is cased.

### Sync engine

Not yet ported; the plan (§10).
What it will be is skysa-notes' engine (`packages/core/src/sync/`) behind a document-format seam: the two places it reads a note — the conflict copy patching a frontmatter `id`, and the pull batch reading a file's identity — become `readDrawingId`/`withDrawingId`, and everything else (the op queue drained in order, the pull batch with its cursor, the conflict rule, the `displace` of a file arriving on a taken path, the backoff, the lock every tab waits on) comes as it is.
The provider factory with its request deadlines is already here (`apps/web/src/sync/providers.ts`).

### Conflict rule (concrete)

Carried over: when a push finds the remote version moved (`ConflictError`), remote keeps the path, and the local text is written beside it as `<name> (conflict <stamp>).svg`, with the same `draw:id` replaced by a new one so the copy is a drawing of its own.
Nothing is ever overwritten by the engine; the user merges by hand, which with two SVG files means opening both.

### Where the user is, in the URL

`/?f=<folder path>&d=<drawing id>`: the open folder and the open drawing, in the query, so a link opens them and the service worker answers it with the shell (§8).
The hash is unused.

### The editor

Not yet built; the direction, so that the store and the file are shaped for it:

- The drawing is put into the DOM as SVG, through a sanitizer (DOMPurify's SVG profile is the candidate; a dependency to be justified when it arrives), so the browser renders it and the editor manipulates elements in place.
  Script, event handlers and external references are stripped on the way in; what is stripped is not written back (§9).
- Pointer events draw: paths, shapes and text as SVG elements; selection, move, resize and rotate as transforms.
- Rasters are `<image>` elements; pixel edits happen on an offscreen canvas and are written back as a new `data:` URL or a new file beside the drawing.
- Export is a render of the SVG onto a canvas (`<img>` of a `blob:` URL drawn with `drawImage`) for PNG and JPEG, and the file itself for SVG.
- Until then the open drawing is shown through an `<img>` of a `blob:` URL (`DrawingView`), which renders every SVG with no script of its own running and no reach into the page.

### The app's words

Carried over from skysa-notes.
Every word the user reads is in the English catalog, `apps/web/src/i18n/en/`, as whole sentences with `{placeholders}` and `{ one, other }` for a count, looked up by `t('…')`; `rich()` renders a message with `<tags>` around words.
`tests/i18n.test.tsx` holds every message to what a translation has to keep.

## 8. PWA specifics

Carried over.

- `vite-plugin-pwa` with `registerType: 'prompt'` and `injectRegister: false`: a new build never swaps itself in under a half-drawn stroke, and nothing inline is written into the page (§9).
  `UpdatePrompt` offers the reload; its `beforeUpdate` is where the sync layer will pause its requests.
- The shell is precached; `/api/*` and the provider origins are `NetworkOnly`, never cached: drawing content must never sit in the HTTP cache.
- Every route of the app is answered with the shell, including `/?f=…&d=…`; any other path on the origin is left to the network, so an operator's page beside the app opens as itself.
  `tests/pwa.test.ts` holds the installability checklist.

**Brand.**
What the app is called and how it looks come from a `brand.json` at build time (`apps/web/brand.ts`): the default brand in `apps/web/brand/` ("Draw", in gray, the pen-stroke icons drawn by `brand/icons.mjs`), or a deployment's own, pointed at with `DRAW_BRAND`.
Name, short name, description, colours for both themes, six icons, optional fonts; the schema is `brand.schema.json`, and `tests/brand.test.ts` stops a build with a brand that would install without its icon.
The brand is never data identity: the app folder, the marker, the database and the cookie names stay whatever it says.

## 9. Security checklist

Carried over; the SVG-specific lines are new.

- `script-src 'self'`, nothing inline, no `eval`, no `new Function` (`public/_headers`, `tests/csp.test.ts`); zod's JIT is turned off before any schema is built (`src/jitless.ts`).
  Load-bearing: the per-connection credential lives in IndexedDB.
- **SVG is script's way in.**
  An SVG in the DOM runs its `<script>`, its `on*` handlers and its `javascript:` hrefs, and can reach the page.
  A drawing is therefore shown through an `<img>` (no script runs, no reach) or put into the DOM only after a sanitizer took those out.
  `connect-src` and `img-src` say where an `<image>` may load from; a drawing from elsewhere may name any `https:` picture, as SVG does.
- `connect-src` lists this origin and the provider hosts the browser syncs with directly, and nothing else; `tests/csp.test.ts` runs each adapter and checks every host it asks.
- `Strict-Transport-Security` for two years on this host alone; `frame-ancestors 'none'`; `form-action 'self'`.
- The credential is sent only as its SHA-256; the server never sees the plaintext (a test greps every response in the flow for a known secret).
- Refresh tokens are sealed in D1 under `SECRETS_KEY` and decrypted only in `POST /api/token`.
- `Cache-Control: no-store` on every API response; `hono/csrf` on the same-origin routes; the flow cookie is `__Host-`.
- No drawing content and no file names reach the Worker, the relay included.
- Core decodes a drawing strictly as UTF-8 and refuses a NUL, so a binary misnamed `.svg` is unreadable rather than rewritten.

## 10. Build record

[`history.md`](history.md), by phase.
What comes next, in order:

1. The sync engine ported from skysa-notes behind a document-format seam (§7, "Sync engine"), with the Dexie `SyncStore` over the schema in §7 and the connect flow's screens.
2. The editor (§7, "The editor"), starting with the sanitizer and vector drawing, then rasters and export.
3. Attachments beside a drawing (§3), which the engine moves with it.

## 11. Repo layout

```
apps/
  api/            Hono on Workers: src/app.ts (createApp), src/worker.ts (the only env reader),
                  src/routes/, src/oauth/, src/db/ (schema), src/relay/ (Durable Object),
                  migrations/ (generated), tests/ (node:sqlite shim for D1)
  web/            Vite + React: src/routes/ (file routes; routeTree.gen.ts is generated),
                  src/store/ (Dexie), src/components/, src/i18n/, src/sync/, src/styles/,
                  brand/ (default brand, icons.mjs), brand.ts, pwa.ts, public/_headers,
                  scripts/bundleBudget.mjs, tests/
packages/
  core/           src/drawing/ (the file), src/names/, src/paths.ts, src/providers/ (+ gdrive/),
                  src/marker.ts, src/entitlements.ts, src/relay.ts, src/api.ts, src/files/,
                  tests/ (providers/contract.ts, stubs, drawing/), tests/testing.ts (test doubles entry)
docs/             this file, history.md, decisions/, self-hosting.md, google-oauth.md
.changeset/       one version for the three packages
.github/          CI (verify, changeset check, generated files, size, minimum Node), release, CLA
```

Layers, enforced by ESLint's `no-restricted-imports`: in core, `names/` sits below `providers/`, `sync/` and `drawing/`, and a provider never imports the engine; in the web app, `lib/` imports nothing of the app, `store/` imports neither the UI nor the sync layer nor the editor, `sync/` never imports the UI, and `drawing/` (the editor, to come) never imports routes or the sync layer.
Core's test doubles are `@skysa/draw-core/testing` and nothing the app ships may import them.

## 12. Carried over from skysa-notes

Decided 2026-11-03; see [`decisions/0002-carried-over-from-skysa-notes.md`](decisions/0002-carried-over-from-skysa-notes.md), which lists each layer, its source commit and what changed on the way.
The short version: the API whole with a fresh schema, the provider adapters and their tests, the naming and path rules, the PWA, brand, CSP and tooling; not the sync engine, the markdown pipeline, the editors or any notes-only feature.
Until a shared package exists, a fix to a carried-over layer is a fix in both repositories; the first fix that has to be made twice is the trigger for the package.

## 13. Distribution and licensing

**Repo.** `github.com/skysa-org/skysa-draw`, public, AGPL-3.0-only (`LICENSE` verbatim, `NOTICE` the copyright notice, `TRADEMARK.md` for the names, two CLAs).
The three packages share one version and one `vX.Y.Z` tag cut by `release.yml` from Changesets.

**The parent project.** A cloud deployment consumes this repository as a git submodule, as it does skysa-notes: it calls `createApp` with its own `EntitlementProvider`, `RateLimiter` and relay, sets `ENABLED_PROVIDERS` and `RELAY`, and builds the web app with its own `DRAW_BRAND`.
Nothing of that deployment is in this repository, and nothing in this repository names it.

**Self-hosting.** `self-hosting.md`: one Cloudflare account, one Worker, one D1 database, the provider registrations, the secrets.

**Dependencies.** MIT, Apache-2.0 or ISC only; a new one says why in its pull request.

## 14. Not planned

- Sign-in, accounts, or anything that knows two connections belong to one person (§6).
- A format of the app's own; a drawing is SVG and stays one (§3).
- Collaborative editing; the relay says "something changed" and nothing else.
- WebDAV (§5.4).

## 15. GitHub setup

As skysa-notes: `main` protected, CI required (`verify`, the changeset check, generated files, the size budget, the minimum Node version), the CLA check on pull requests, Dependabot for the workspace, `CODEOWNERS` at the root.
