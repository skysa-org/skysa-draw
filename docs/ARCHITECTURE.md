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
| Layers | A layer is a direct child of the root that draws, `vector`, `raster` or `group`; what SVG can say about it is said SVG's way, what it cannot is a `draw:*` attribute (§3, "Layers"; `decisions/0003-layers.md`) | What Inkscape and Illustrator already do, so a file from either has layers here and a file from here has layers there |
| The editor | SVG in the DOM, through a sanitizer, edited with pointer events; one tool is one tool on a vector layer and on a raster one (§7, "The editor") | The file is the document; the editor is a view over it |
| The interface | One set of components, placed by the window's size class, `compact`, `medium` or `expanded`; the tools users know, under the keys they know (§7, "The interface"; `decisions/0004-the-interface.md`) | A phone, a tablet with a pen and a desktop are one app, not three |
| Files from elsewhere | Shown as the browser renders them; given an id on the way in, otherwise untouched (§3) | What the editor does not know is kept, never dropped |
| Deployment | One Cloudflare Worker serves the SPA and `/api`; D1 for the database; self-hostable end to end (`self-hosting.md`) | One origin, first-party cookies, free tier enough for one person |
| What an operator can change | The `EntitlementProvider`, `RateLimiter` and relay seams of `createApp`, the env flags, and the `DRAW_BRAND` build input (§8, §13) | No deployment-specific code in the repository |
| License | AGPL-3.0-only, with a CLA (§13) | Same as skysa-notes |
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

What the app writes on "new drawing" (`emptyDrawing`): the root with its namespaces, id and canvas, the title, and one empty vector layer.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:draw="https://skysa.org/draw/1" draw:id="7f1b8c2e-…" viewBox="0 0 1600 1000" width="1600" height="1000">
  <title>Floor plan</title>
  <g id="layer-1" draw:kind="vector"/>
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
`readDrawingProlog` is everything before the root tag, which the editor keeps in front of what it serializes (§7, "The editor").
The layer vocabulary, the attribute names, the kinds, the blend modes and the raster limits, is core's too (`packages/core/src/drawing/layers.ts`), so the editor and the tests name them from one place.

### Layers

Decided 2026-11-04; see [`decisions/0003-layers.md`](decisions/0003-layers.md).
A layer is a direct child of the root that draws something: a `<g>`, or a graphics element on its own.
`<defs>`, `<title>`, `<desc>`, `<metadata>`, `<style>` and the elements that only define things (`symbol`, `marker`, `pattern`, the gradients, `filter`, `mask`, `clipPath`) are not layers.
Document order is paint order, bottom to top; the layers panel shows the top first.

Each layer is of one kind, and the app writes the kind on the layers it makes, `draw:kind`:

- `vector`: a `<g>` of SVG's own graphics elements, as any tool writes them: `path`, `rect`, `ellipse`, `line`, `polygon`, `text`.
- `raster`: a `<g>` holding one `<image>` with `x`, `y`, `width` and `height` in user units and `preserveAspectRatio="none"`, so the layer carries its transform, opacity, blend, mask and filter like any other.
  The pixels are the image's own: one per user unit up to `RASTER_MAX_SIDE` on the longer side, past which a canvas has fewer pixels than units.
  A pixel edit re-encodes the image whole as PNG; a picture placed from a file keeps its bytes and its type until a pixel of it changes.
  The bytes are inline, a `data:` URL, until attachments beside the drawing arrive (§10), when `INLINE_RASTER_BYTES` decides which go beside.
- `group`: a `<g>` of layers, each by these rules.

What SVG can say about a layer is said SVG's way, where any renderer and any other tool reads it: hidden is `display="none"`, opacity is `opacity`, the blend mode is `mix-blend-mode` in `style` (it has no presentation attribute), a mask, a clip and an adjustment are `mask`, `clip-path` and `filter` referring into the root's `<defs>`, and position is `transform`.
What SVG cannot say is the app's: `draw:name`, the name the user gave it, and `draw:locked`.
A layer's `id` is `layer-<n>`, the smallest `n` free in the document; the history, the masks and the clips refer to a layer by it, and an unnamed layer is shown as "Layer n" by its number, so a layer keeps its number when it is moved.

A file from elsewhere has layers by the same rules without a byte written to it: a `<g>` with no `draw:kind` is vector unless its only graphics child is one `<image>`, which makes it raster; a graphics element loose at the root is a vector layer of one element, wrapped in a `<g>` the first time it is edited; a layer with no `id` is given one the first time the file is written; `inkscape:label` is read as a name where `draw:name` is absent, and never written.
A `<g>` is a group only where it says so.

What the body holds beyond this is the editor's business (§7, "The editor"), with two rules.
Adjustments are SVG's own filters, masks and clip paths, so they stay editable and a flattened export is a render.
Nothing is dropped: an element the editor does not know is kept where it was and shown as the browser renders it, except what the sanitizer takes out (§9), which no drawing needs.

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

Carried over whole; each adapter's file says what it learned of its provider, with the vendor's URL beside each claim.
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
drawings     [connectionId+id], id, connectionId, path, [connectionId+path], dirty, deletedLocally, updatedAt, remoteId
folders      [connectionId+path], connectionId, path
syncState    connectionId
opQueue      ++seq, connectionId, drawingId, path, fileId
prefs        key
credentials  id
files        [connectionId+id], connectionId, [connectionId+path], [connectionId+remoteId]
fileBytes    [connectionId+id], connectionId, [pinned+lastUsedAt]
```

- A `DrawingRecord` holds the SVG text whole, its title, its path, its `contentHash`, the `syncedHash` it last agreed on with the provider, the provider's `remoteId` and `remoteVersion`, and `dirty` as 0/1 (IndexedDB cannot index a boolean).
- Each connected account is its own silo, keyed by connection and `draw:id`; `local` is the device's own pile, written in while nothing is connected, and the source showing is the pref `sync.activeConnection`.
- `syncState` holds one row per connection; `credentials` holds the `sk1_…` credential, whose SHA-256 alone reaches the server (§6); `files` and `fileBytes` hold the files beside a drawing and the bytes cached of them.
- The database's name is data identity and not brand: a deployment that renames the app keeps it (§8).
- A later version adds a `version(n).stores()` with an `upgrade()` and never edits an earlier one.
  Version 1 was rewritten in place once, for the sync port, since it had never shipped; its shape is skysa-notes' store without the clipboard, picture and key tables.

### What the app does to drawings

`store/drawings.ts` and `store/folders.ts`: each change is one transaction over the rows and the op queue together, so the queue never says something the rows do not.

- `createDrawing`: an empty canvas, or text brought in from a file, given this app's id if it has none; its filename the title's slug, unique in the folder; a `write` queued.
- `saveDrawing`: the editor's text, with the drawing's own id written in whatever the text carried; a save of the same text is ignored; a compare-and-set, given the texts the editor last opened or saved as `expected`, so a row changed from elsewhere since is answered `changed` with nothing written; one `write` waits per drawing however many saves come, and the push sends what the row holds then.
  The hash is computed before the transaction opens: Web Crypto is a wait IndexedDB does not hold a transaction across.
- `renameDrawing`: into the file's `<title>` and into the filename; a `move` queued where the name changed, and a `write`.
- `deleteDrawing`: a tombstone now (`deletedLocally`), shown nowhere; its writes withdrawn and a `delete` queued, which the push sends where the provider has the file and settles with nothing sent where it never did; the pile's tombstones are dropped when the pile goes into a connection.
- `createFolder`: refused where the parent has the name however it is cased.
- `createDrawing` takes a `filename` chooser, run inside its transaction, for a name that is not the title's slug: a conflict copy's.

### Sync engine

Ported from skysa-notes v2.1.1 (`b39c8e42`) into `packages/core/src/sync/`, with its tests in `packages/core/tests/sync/`; the Dexie `SyncStore` under it is `apps/web/src/sync/store.ts`, held to the contract in `apps/web/tests/sync/syncStore.test.ts`, and the scheduler, one engine per connection under the Web Lock `skysa-draw:sync:<connectionId>`, is `apps/web/src/sync/scheduler.ts`, started in `main.tsx`.
It is skysa-notes' engine behind a document-format seam, `sync/document.ts`, the one module of the engine that knows what a drawing's file holds: the id a file claims (`claimedId`, `readDrawingId`), a conflict copy's contents (`conflictContent`: the local text with a new `draw:id`, by `withDrawingId`), and every read that holds or compares a drawing (`readDrawingText`), which answers a `.svg` that is not an SVG document as `UnreadableError`, as §3 says.
ESLint holds the seam: nothing else in `sync/` imports `drawing/`.
Everything else comes as it is: the op queue drained in order, the pull batch committed with its cursor, the conflict rule, the `displace` of a drawing on a path a remote file arrives at, the backoff, files beside a drawing (`SyncFile`, mirrored and never read), folders and their deletions, `listsEverything` and `leaveFolder`, `writesAtOnce`, progress and the outcome.
A file another tool made keeps its bytes when it is pulled: the engine gives it an id without writing it in, and the first save writes it.
The engine's conflict copy keeps the drawing's `<title>` and takes a new `draw:id` only, where the editor's own copy (below, "Conflict rule") is retitled `<title> (conflict <stamp>)` in the catalog's words; making the two agree is a known gap (§10).
Cut as notes-only: the outcome's `clipboard` and `encryption` flags (`metIn`, `metOf`), and the hidden folders notes synced at the root.
The engine's comments cite skysa-notes' docs/ARCHITECTURE.md §7 by section, where its design is written down; they are left as they came, so a fix can be carried between the two (§12).
Every store is held to one contract, `describeSyncStoreContract` from `@skysa/draw-core/testing`, over the in-memory store in core and the Dexie store in the web app.
The provider factory with its request deadlines is `apps/web/src/sync/providers.ts`.
The rest of skysa-notes' web sync layer came with it, renamed by the same scripts: the connection, the credential, the token, account, relay and API clients, the connect code, held edits, and the tabs that stand against each other (`decisions/0002-carried-over-from-skysa-notes.md` lists what was cut).
The connect flow's screens sit at the top of the library at every size (`components/sources/`, `components/account/`), drawn on this app's own components, with the app's own marks for the providers and no vendor's logo.

### Conflict rule (concrete)

Carried over: when a push finds the remote version moved (`ConflictError`), remote keeps the path, and the local text is written beside it as `<name> (conflict <stamp>).svg`, with the same `draw:id` replaced by a new one so the copy is a drawing of its own.
Nothing is ever overwritten by the engine; the user merges by hand, which with two SVG files means opening both.

The editor applies the same rule on the device, at once, to an open drawing (`drawing/useOpenDrawing.ts`).
When the row changes under unsaved edits, from another tab or from a pull, the row keeps the other change; the edits are written beside it as `<name> (conflict <stamp>).svg` with a new `draw:id` and the title `<title> (conflict <stamp>)`, and the editor reopens on the row and says where the copy went.
When the row is deleted under unsaved edits, by another tab or a pull, the edits become a new drawing in its folder, under its title and with a new `draw:id`, since the old id now means deleted; the editor moves to it, replacing the entry in the history.
A save the delete beat counts as unsaved; edits already saved go with the delete.
The user's own delete goes through the open drawing, which marks it intended before the row goes, so it leaves nothing behind.
`saveDrawing` is a compare-and-set: the editor passes what it last opened or saved as `expected`, and a row changed from elsewhere since is answered `changed` with nothing written; the edits are then kept as a copy, as above, and a save still in flight counts as unsaved until it lands.

### Where the user is, in the URL

`/?f=<folder path>&d=<drawing id>`: the open folder and the open drawing, in the query, so a link opens them and the service worker answers it with the shell (§8).
The hash is unused.
A `d` this device has no drawing for shows a sentence saying so and the way back, once the store has answered: `useDrawing` tells loading, a row and missing apart.

### The editor

Decided 2026-11-04 with the layers (`decisions/0003-layers.md`) and the interface (`decisions/0004-the-interface.md`); the first increment is built (§10).
`apps/web/src/drawing/`: a view over the drawing's SVG text, which stays the only source of truth.

**The document in the DOM.**
The text is parsed as XML (`DOMParser`, `image/svg+xml`) and sanitized in place by DOMPurify (`document/sanitize.ts`) before any of it is rendered: script, event handlers, `javascript:` URLs, a `data:` URL that is not `data:image/`, `<foreignObject>`, and a `<use>` that reaches outside the document are taken out.
An element or an attribute in a namespace that is not SVG's, XHTML's or MathML's is inert and is kept, so Inkscape's vocabulary and the app's own survive (§9).
DOMPurify removes every element outside those three namespaces whatever it is told, so a foreign element is lifted out before it runs, stripped of anything in those three namespaces, and put back where it was afterward; a foreign element is never allowed by its bare name, which would let a real `<script>` through under the same name.
The sanitized root is mounted in a shadow root inside the viewport, so a `<style>` the drawing carries styles the drawing and not the app.
The editor's commands change elements in place.
The text is serialized back (`XMLSerializer`, behind the file's own prolog, `readDrawingProlog`) only after a command ran: a drawing opened and closed is the same bytes, and `saveDrawing` ignores a save of the same text.
A serializer that writes the root as `<svg:svg>`, as the DOM Parsing spec does for a root that also binds `xmlns:svg` (every Inkscape file), is answered by writing `<svg>` (`document/serialize.ts`).
What the sanitizer removed is therefore gone from a file the user edits, and that is on purpose; a file the user only looks at is untouched.

**Commands and history.**
Every change is a command with an inverse, executed through the document, which tells the React tree (`useSyncExternalStore`); a command that changed nothing is not recorded (`document/commands.ts`).
A vector command keeps deep clones of the layer before and after, not its markup: once the root is in the page, `outerHTML` is HTML serialization, which XML cannot always read back.
A raster command keeps the image's `href` before and after, so a stroke costs the history one encoded layer, not the whole file.
Every command restores the attributes it touched in their order, and takes back a namespace declaration it added, so undoing to the start gives back the file's own bytes.
A loose element wrapped into a layer passes an id the app gave it on open (`layer-n`) to its new `<g>`, so the layer keeps its number; an id of the file's own stays on the element.
Undo and redo are per open drawing, in memory, as long as the session, capped by bytes rather than by count (`HISTORY_BYTES`).

**Layers**, as §3 defines them: add, delete, duplicate, reorder, hide, lock, rename, opacity, blend mode, group and ungroup, clip to the layer below, merge down and rasterize, with the file's shape for each in `decisions/0003-layers.md`.
Merge down of two vector layers stays vector; a merge that involves pixels, and rasterize, render the layers to pixels (`document/layerPixels.ts`, through the export's render) as a job the document waits for, dropped if the drawing changed while it rendered.
Moving a layer into or out of a group is to come.
One layer is active; tools act on it, and a tool that does nothing on its kind says so and is not available.

**Tools.**
One tool is one tool: the same name, the same key and the same options whether the active layer is vector or raster, doing on each what a user of that tool expects (`decisions/0004-the-interface.md` lists them).
Pointer Events alone drive them, in user units through the viewport's inverse transform, with `pressure`, `tiltX` and `tiltY` where the device gives them and `getCoalescedEvents()` so a fast stroke keeps every sample.
On a vector layer a stroke is a `<path>`, a brush stroke a filled path whose width follows pressure, a shape its own element, and selection, move, resize and rotate are `transform`s.
On a raster layer a stroke is painted on a canvas the size of the layer's pixels, shown live, and written into the `<image>` when the stroke ends; the encoding is asynchronous and a save waits for it.
Writes land in the order the strokes were made, whatever order their encodings finish in, and a stroke that changed no pixel writes nothing, so a picture keeps its bytes until a pixel of it changes (§3).
Adjustments are a stack of SVG filter primitives on the layer, each previewed live while its slider moves and made one command when it is let go, as opacity is.
Crop is the canvas's `viewBox`, and `width` and `height` where the file has them, scaled in their own unit; nothing is resampled, and the viewport refits to the new box.
A `transform` on a raster layer is a transform, never a resample, until the user rasterizes it.
The pen draws a `<path>` of cubic segments, a click a corner and a drag a smooth point; a click on the first point closes it, a click on the last or Enter finishes it, and Escape keeps a path of two points or more, as Illustrator and Figma do.
The node tool moves a path's anchors and handles and inserts a point where a segment is pressed, and turns a shape (`rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`) into a path on its first edit, keeping its id and its other attributes.
Path data is read as a browser reads it, every command, with arcs as cubics, and written back as `M`, `L`, `C` and `Z` to two decimals (`tools/vector/path/`).
The text tool types into a field over the canvas, opened as the pointer lifts so a pinch opens none, and writes one `<text>`, a `<tspan>` to a line, in one command; its face is named (`sans-serif`), so it is the same in the editor, in a thumbnail and in another tool.
A tool may ask for another (`ToolContext.useTool`): the viewport asks the frame, which holds the tool in hand, and once the new tool is in hand and the last put down, hands it the element to edit (`ToolBehavior.edit`, `viewport/toolHandover.ts`).
The tool in hand is told when the options change (`ToolBehavior.optionsChanged`), with a context that has them, so what it holds open follows; a tool may set them too (`ToolContext.setOptions`), as the text tool does with an edited text's own size and fill.
The text tool's field stays open while the focus is where the options are set (`data-tool-options`, `tools/optionsRegion.ts`), and shows a new size or fill at once.
While the field is open on a text, the text is hidden by a rule beside the root in the viewport's shadow root, never by a change to the drawing, and the field follows it through an undo or a redo, to the copy an undo puts in its place, writing nothing once it is gone (`tools/vector/textHide.ts`).
An edited text's `font-size` and `fill` are written in the same one command as its words, only those changed while the field was open and different from the text's own, as attributes, and taken out of its `style` and its `<tspan>`s.
A double press with the select tool opens a text in the text tool with the caret at the press, and a path, a shape, or the path under the press in a group, in the node tool (`tools/vector/doublePress.ts`).
The marquee, the lasso and the magic wand make the area selection, a closed path in user units that outlives the tool: on a raster layer every painting tool paints inside it, the fill floods only inside it and Delete clears it; on a vector layer it selects the elements it touches and is dropped.
Shift adds a subpath, a union under `nonzero`, and keeps the area's feather; subtracting is not built, and Shift over an inverted area starts a new one, since adding to an inverse is a difference of outlines, which no fill rule gives.
The magic wand makes the area from a color, as Photoshop's does (`tools/raster/wand.ts`).
A click on a raster layer selects the pixels within the tolerance of the one clicked, by the fill's distance over all four channels, so a click on a clear pixel selects the clear ones.
With Contiguous on, the default, those are the pixels joined to it by their sides, as the fill floods; with it off, every such pixel of the layer.
The mask is traced along the pixels' edges into loops, each straight run one segment, outer boundaries clockwise and holes the other way, so under `nonzero` a ring keeps its hole and a subpath Shift adds is a union with it (`tools/raster/trace.ts`).
The corners come into user units through the inverse of the layer's pixel map, its `transform` included, and are written to two decimals as the marquee writes its own.
Tracing is linear in the mask and never recurses; an outline past a million corners is refused with a notice, since every stroke inside the area reads it again.
Shift adds as the marquee adds, a click outside the layer's pixels deselects, a locked layer may be selected from and a hidden one may not, and nothing enters the history.
Since a wand's outline has holes, an inverted area asks the winding, not whether a subpath holds a box, to tell what is in its hole (`reachesArea`).
On a vector layer the wand selects every element of the active layer painted within the tolerance of the one clicked, by its fill where that is a color and its stroke where it is not, a filled element matching only filled ones, as Illustrator's wand does by default; Contiguous does not apply there.
Select inverse makes the area the canvas outside the outline, and feather fades its edge over a distance in user units either side of the outline.
Neither is a clip, since a clip cannot take a complement where subpaths overlap: every write through an inverted or feathered area composites by its mask, the outline filled through the canvas's `filter: blur()` at a deviation of half the feather and, for an inverse, taken out of the canvas (`areaMask`).
So a brush stroke, a fill, Delete and the smudge change each pixel by as much as the area covers it, and a feathered edge keeps its partial alpha; where the canvas has no `filter` (Safari before 18) the edge is hard.
The live stroke is exact for a plain or an inverted area, and shows a feather's edge hard, on the outline, until the stroke lands.
The marching ants trace the outline, and for an inverse the canvas's edge too.
Fill… fills the area as its dialog says (`tools/raster/areaFill.ts`, `fillAreaWith`), in one command (`regions.fill`), with the fill color, the stroke color, a color of the user's own, or the picture around the area made again (Content-Aware), then a blend mode, an opacity and Preserve transparency, as Photoshop's Edit > Fill asks them.
The mode is the canvas's `globalCompositeOperation`, `normal` as `source-over`, and Preserve transparency draws the layer's own pixels back `source-atop` over the fill, so their alpha is kept in every mode.
A stroke of none fills with the fill color, as the fill tool pours it, and Alt or Option Backspace and Ctrl or ⌘ Backspace are Fill… with the fill or the stroke color in normal at full opacity.
Content-Aware remakes every pixel the area covers at all, then lays the result over the layer by coverage and opacity, replacing the pixels in normal mode, so a hole over transparency can fill transparent.
It is asynchronous and is a pending write the save waits for; a status over the canvas shows it working, and Escape or its Stop aborts the engine.
An undo, a redo or any write to the layer while it works makes its result stale, and the fill is dropped with a notice rather than written over pixels it was not made from.
Layer via copy or cut makes the area's pixels a new raster layer directly above, in the same place, in one command with the cut.
Content-aware fill (`drawing/inpaint/`) makes the pixels under a mask again from the rest of the layer, as Photoshop's Edit > Fill > Content-Aware does.
It is the inpainting of Wexler, Shechtman and Irani ("Space-Time Completion of Video", IEEE PAMI 2007), coarse to fine, with the nearest patches found by PatchMatch (Barnes, Shechtman, Finkelstein and Goldman, "PatchMatch: A Randomized Correspondence Algorithm for Structural Image Editing", SIGGRAPH 2009), the method Content-Aware Fill itself was built on.
Patches are 7 × 7 pixels, compared by the sum of squared differences over the four channels premultiplied by alpha, so alpha is filled like a color and a hole on transparent pixels fills transparent.
Only patches of known pixels are sources, drawn from a band around the hole: its box grown on every side by its longer side, at least 32 pixels, inside the picture, so a small hole in a large picture costs what the hole costs.
The band is halved into a pyramid, a coarse pixel a hole if any of its four is, until the hole is 24 pixels across or less.
The coarsest hole is filled from its edge inward, ring by ring, each pixel copied from the source that best matches what is known or already filled of its patch: the "onion peel" of Newson, Almansa, Gousseau and Pérez ("Non-Local Patch-Based Image Inpainting", IPOL 2017), so a line that meets the hole is carried in from either side.
Each finer level starts from the matches of the one below at twice the offset, and each level between the coarsest and the finest is peeled again from its edge with the guess from below counting a twentieth as much as a known pixel, which keeps the layout found where the picture was small and still carries in a line too thin to be seen there.
At every level, rounds of two PatchMatch passes (propagation, then random search in a window halved from the band's size to one pixel) and a vote make the hole again: 8 rounds at the coarsest level, 4 between, 2 at the finest.
The vote is Wexler's: each pixel is the mean of what the patches over it say, each patch counted by exp(−d / 2σ²), σ² the 75th percentile of the distances, and by 1.3 for each ring nearer the known pixels it is.
The random numbers come from a seeded xorshift generator, so the same layer and mask give the same bytes, in a worker or not.
It runs in a module worker of its own (`inpaint.worker.ts`, a file of the app's own origin, so `worker-src 'self'` allows it and nothing is added to the policy), given copies of the pixels and the mask with their buffers transferred, and terminated once it answers or the fill is canceled; where there is no `Worker`, the same engine runs on the page, yielding between its steps.
A 400 × 400 hole in a 2000 × 1500 picture takes about a second on an Apple M4.
The move tool over an area on a raster layer moves the area's pixels wherever the drag begins, as Photoshop's does: each pixel by as much as the area covers it, in whole pixels of the layer, leaving transparency where they were, with the marching ants moved by as much (`tools/raster/move.ts`).
Alt held as the drag begins moves a copy; Shift holds the move across, down or at 45°; the arrows nudge by a pixel, or ten with Shift; an inverse moves everything outside its outline and stays an inverse.
With no area, or one that covers none of the layer's pixels, the layer moves whole by its `transform`, as before.
Each drag or nudge is one command (`regions.move`), refused where the file's picture moved while it was encoded.
The pixels float, as in GIMP: the tool keeps in memory what lay beneath them and the pixels themselves, so a later drag gives back what they covered.
The file holds the result after every drag, and the float ends when the area is replaced, the layer is written by anything else or its picture moved, its `transform` changes, or another layer is moved.
While the drag lasts, the screen canvas shows the pixels where they are going, and the hole they leave is a mask in an `<svg>` beside the drawing's root in the viewport's shadow root, so nothing in the drawing changes until the command runs.
A marquee or lasso drag that begins inside the area, without Shift or Alt, moves its outline alone.
The move tool's Auto-select (`tools/common/autoSelect.ts`) picks the layer a press acts on (`Tool.pick`): the topmost, walking the paint order down and into groups past hidden ones, that is more than half opaque under the press as seen.
A vector layer is read by the select tool's own hit (`elementAt`), a raster layer by one pixel (`tools/raster/probe.ts`): from its surface where one is decoded, otherwise from its `<image>` drawn onto a canvas of one pixel, so no surface is made of a layer only looked at.
On a 4096 × 3072 PNG the first read took 66 to 120 ms in Chromium, Firefox and WebKit, the browser's own decode, and every read after it under a tenth of a millisecond, against 89 to 183 ms and 48 MB for a surface.
The viewport asks the tool before the press begins, has the frame make the layer active (`onActivateLayer`), and begins the press with a context of that layer and the behavior for its kind, so the whole press is that layer's before the frame shows it.
Activating a layer is not a command, and a canceled press gives the layer back.
A selection is dropped when another layer is made active unless it is that layer's own, so the element the press selected stays selected.
Ctrl or ⌘ A selects all, the elements on a vector layer and the canvas elsewhere, and D drops both.
The selection's actions are one list (`drawing/selectionActions.ts`) built from the area, the selected elements, the active layer and the history; the canvas's context menu and the options strip's selection bar both show it (`decisions/0004-the-interface.md`, "The context menu").
What each action does is the viewport's (`viewport/selectionCommands.ts`), reached through `ViewportHandle.perform`, so a key, a menu item and a bar button do the same thing.
The frame holds the selection (`viewport/selectionState.ts`) and passes it to the viewport, so the bar and the feather dialog can see it.
Layer via copy and cut on a vector layer is one command (`document/layerVia.ts`) that keeps only the selected elements in a copy of the layer, and for a cut takes them from the source, and undoes to the file's exact bytes; on a raster layer it is the raster tools' `layerViaArea`.
Smudge pushes the layer's own pixels, each dab picking up what lies under the one before, in one command when the stroke ends.

**Export** (`drawing/export/`) is a render of the SVG onto a canvas (`<img>` of a `blob:` URL drawn with `drawImage`, the root given the export's pixels as its size) for PNG, JPEG and WebP from 0.5× to 4×, the longer side kept to 16,384 px (`EXPORT_MAX_SIDE`), a JPEG on white unless another background is chosen; and the file itself for SVG.
A picture placed from a file, a paste or a drop is a new raster layer holding the file's bytes as they came, of the type its header says, fitted inside the canvas and never enlarged (`placePicture`); an SVG is placed the same way, as `data:image/svg+xml`, which a browser draws as a picture with no script.

**Still an image.**
A drawing that is not open in the editor, in the list, as a thumbnail, or one the sanitizer could not parse at all, is shown through an `<img>` of a `blob:` URL (`DrawingView`), which renders any SVG with no script running and no reach into the page.

### The interface

Decided 2026-11-04; see [`decisions/0004-the-interface.md`](decisions/0004-the-interface.md).

**Size classes.**
The window is `compact` under 600 px wide, `medium` from 600 to 839 and `expanded` from 840, Material's window size classes, read from `matchMedia` by `useSizeClass` (`components/ui/sizeClass.ts`) and nowhere else: a component never asks how wide the window is; the frame places it, and the component fits its container (`@container`).

**One set of components**, `apps/web/src/components/ui/`: `ToolBar` (horizontal or vertical, one tab stop and the arrow keys, as WAI-ARIA's toolbar pattern says), `ToolButton` (a long press for a tool's variants), `IconButton`, `Panel`, `PanelHost` (a bottom sheet on compact, a drawer over the canvas on medium, a docked column on expanded), `Slider`, `ColorField`, `ColorPair` (the fill and the stroke at the foot of the tool bar), `Select`, `Menu`, `ContextMenu`, `Notice`, and the icons, drawn by hand at 24 px in `icons.tsx` and looked up by name through `ICONS`.
Every control is at least 44 CSS px in either direction, whatever the size class and whatever the pointer; keyboard focus shows a ring; words come from the catalog.

**The frame** (`drawing/Editor.tsx`) places them:

```
compact    ┌ top bar: back · title · undo · redo · more ─┐
           │ canvas                                      │
           │ options, one row, for the active tool       │
           └ tool bar: the tools · colors · layers ──────┘   layers and colors open as sheets
medium     ┌ top bar ────────────────────────────────────┐
           │ rail │ options                              │
           │ rail │ canvas                               │   layers and properties in a drawer over the canvas
           └──────┴─────────────────────────────────────┘
expanded   ┌ top bar ────────────────────────────────────┐
           │ rail │ options              │ layers        │
           │ rail │ canvas               │ properties    │   the dock stays; both columns open from 1200 px
           └──────┴─────────────────────┴───────────────┘
```

An open drawing fills the window on every size; the library (folders and drawings) is the screen before it on compact and a drawer from the top bar elsewhere, as a gallery is to a canvas.
On compact the zoom and the saving status are under More, to keep the bar to one row; the options row comes after the canvas in the page there and before it elsewhere, so reading order is the order seen.
The color panel is a drawer on medium and expanded alike; the dock holds layers and properties, follows the 1200 px rule until the layers button is pressed, and then stays as the user left it.
The two colors sit at the foot of the tool bar (`ColorPair`; `decisions/0004-the-interface.md`, "The two colors"): on the rail the fill, the stroke and the swap, a 44 px target each; on compact both colors as one control and the swap; on every window the reset is the color panel's, and D's.
A press on a color opens the color panel on it (`editColor`, `colorSlot` in `editorState.ts`).

**Input.**
Pointer Events only, `touch-action: none` on the canvas; a pen draws, a finger draws unless a pen is down (palm rejection), two fingers pan and pinch to zoom, a two-finger tap undoes and a three-finger tap redoes; a wheel scrolls, with Ctrl or ⌘ zooms, and Space held pans.
Keys on every size, since a tablet may have a keyboard: a letter per tool and the editing keys users know, in one map (`drawing/keys.ts`).
`prefers-color-scheme` and `prefers-reduced-motion` are honored through the tokens (`styles/tokens.css`); safe areas through `env(safe-area-inset-*)`; the canvas draws at `devicePixelRatio`.

### The app's words

Carried over from skysa-notes.
Every word the user reads is in the English catalog, `apps/web/src/i18n/en/`, as whole sentences with `{placeholders}` and `{ one, other }` for a count, looked up by `t('…')`; `rich()` renders a message with `<tags>` around words.
`tests/i18n.test.tsx` holds every message to what a translation has to keep.
The catalog, the code and the docs are US English; British English, if it is wanted, is a catalog of its own (`en-GB`), not a change to this one.

## 8. PWA specifics

Carried over.

- `vite-plugin-pwa` with `registerType: 'prompt'` and `injectRegister: false`: a new build never swaps itself in under a half-drawn stroke, and nothing inline is written into the page (§9).
  `UpdatePrompt` offers the reload; its `beforeUpdate` is where the sync layer will pause its requests.
- The shell is precached; `/api/*` and the provider origins are `NetworkOnly`, never cached: drawing content must never sit in the HTTP cache.
- Every route of the app is answered with the shell, including `/?f=…&d=…`; any other path on the origin is left to the network, so an operator's page beside the app opens as itself.
  `tests/pwa.test.ts` holds the installability checklist.

**Brand.**
What the app is called and how it looks come from a `brand.json` at build time (`apps/web/brand.ts`): the default brand in `apps/web/brand/` ("Draw", in gray, the pen-stroke icons drawn by `brand/icons.mjs`), or a deployment's own, pointed at with `DRAW_BRAND`.
Name, short name, description, colors for both themes, six icons, optional fonts; the schema is `brand.schema.json`, and `tests/brand.test.ts` stops a build with a brand that would install without its icon.
The brand is never data identity: the app folder, the marker, the database and the cookie names stay whatever it says.

## 9. Security checklist

Carried over; the SVG-specific lines are new.

- `script-src 'self'`, nothing inline, no `eval`, no `new Function` (`public/_headers`, `tests/csp.test.ts`); zod's JIT is turned off before any schema is built (`src/jitless.ts`).
  Load-bearing: the per-connection credential lives in IndexedDB.
- **SVG is script's way in.**
  An SVG in the DOM runs its `<script>`, its `on*` handlers and its `javascript:` hrefs, and can reach the page.
  A drawing is therefore shown through an `<img>` (no script runs, no reach) or put into the DOM only after a sanitizer took those out.
  The sanitizer is DOMPurify, over the XML-parsed document and in place, with elements and attributes in a namespace that is not SVG's, XHTML's or MathML's kept, since those are inert (§7, "The editor"); `apps/web/tests/drawing/sanitize.test.ts` holds the list of what goes and what stays.
  The CSP is the backstop behind it: an inline script that got through would still not run.
  The sanitized drawing is mounted in a shadow root, so its `<style>` cannot restyle the app or lay a `position: fixed` box over it (§7, "The editor").
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

1. Attachments beside a drawing (§3), which the engine moves with it, and with them `INLINE_RASTER_BYTES`.

Known gaps in what is built, each for an issue:

- Tested under jsdom, which has no 2D canvas, no `getBBox`, no `DOMMatrix` and no stylesheets from an SVG `<style>`, and driven once by hand in headless Chromium under the real Content-Security-Policy (vector and raster strokes, smudge, pen, text, merge down, rasterize, undo, PNG export, the frame at three widths); not yet on a touch screen, with a stylus, or in Safari or Firefox.
- Renaming a drawing reopens it and loses its undo history, since `renameDrawing` rewrites the row's text.
- A tool that does nothing on the active layer's kind says so when pressed, but its button is not shown as unavailable.
- The library drawer's own rows (`Sidebar`, `DrawingList`) are below the 44 px target.
- A stroke still under way when the editor reopens on a change from elsewhere is lost; an undo pressed while a raster stroke is encoding is overtaken when the stroke lands.
- A drawing's `@font-face` does not apply inside the shadow root in Chromium, so its embedded fonts may not show in the editor.
- Deleting a layer leaves the clips that name it, and those layers show nothing until their clip is released; a clipped layer moved by a `transform` moves its mask with it.
- The pen finishes a path when the tool changes by watching the overlay being emptied, and listens for Enter and Escape on the document between clicks, since the viewport tells a tool only about strokes; a tool key pressed during a pen drag leaves the path open until Enter or Escape; a `finish` member of the tool contract, called by the viewport, would replace both.
- A save that arrives after its source was let go is refused, where skysa-notes makes the drawing again under a detached source (`bringBack`, `ensureDetached`); `settleEditors` covers a release, not an undo that outlives it.
- Per-source preferences (skysa-notes' `sourcePrefs`) are not kept.
- Web Locks, BroadcastChannel, the wake lock, the relay WebSocket and IndexedDB are tested only through fakes and fake-indexeddb, and no provider has been connected for real.
- A conflict copy the sync engine makes keeps the drawing's title, so the list shows two drawings by one name until one is renamed; the store contract pins the copy's text to `conflictContent`, so retitling it means giving the contract the store's words for the title.

## 11. Repo layout

```
apps/
  api/            Hono on Workers: src/app.ts (createApp), src/worker.ts (the only env reader),
                  src/routes/, src/oauth/, src/db/ (schema), src/relay/ (Durable Object),
                  migrations/ (generated), tests/ (node:sqlite shim for D1)
  web/            Vite + React: src/routes/ (file routes; routeTree.gen.ts is generated),
                  src/store/ (Dexie), src/components/ (ui/ the shared set; shell/, sidebar/, list/, sources/, account/),
                  src/drawing/ (the editor: document/, tools/, panels/, Editor.tsx, Viewport.tsx, keys.ts),
                  src/i18n/, src/sync/ (scheduler, SyncStore), src/api/, src/errors/, src/hooks/, src/styles/,
                  brand/ (default brand, icons.mjs), brand.ts, pwa.ts, public/_headers,
                  scripts/bundleBudget.mjs, tests/
packages/
  core/           src/drawing/ (the file), src/names/, src/paths.ts, src/providers/ (+ gdrive/),
                  src/sync/ (the engine; document.ts is its seam),
                  src/marker.ts, src/entitlements.ts, src/relay.ts, src/api.ts, src/files/,
                  tests/ (providers/contract.ts, stubs, drawing/, sync/: the engine's tests,
                  the store contract, the simulation kit), tests/testing.ts (test doubles entry)
docs/             this file, history.md, decisions/, self-hosting.md, google-oauth.md
.changeset/       one version for the three packages
.github/          CI (verify, changeset check, generated files, size, minimum Node), release, CLA
```

Layers, enforced by ESLint's `no-restricted-imports`: in core, `names/` sits below `providers/`, `sync/` and `drawing/`, `drawing/` sits below `providers/` and `sync/`, a provider never imports the engine, and the engine reaches `drawing/` only through `sync/document.ts`; in the web app, `lib/` imports nothing of the app, `store/` imports neither the UI nor the sync layer nor the editor nor the API client, `api/`, `errors/` and `hooks/` import neither the store nor the sync layer nor the UI, `sync/` never imports the UI, and `drawing/` (the editor) never imports routes or the sync layer.
Core's test doubles are `@skysa/draw-core/testing` and nothing the app ships may import them.

## 12. Carried over from skysa-notes

Decided 2026-11-03; see [`decisions/0002-carried-over-from-skysa-notes.md`](decisions/0002-carried-over-from-skysa-notes.md), which lists each layer, its source commit and what changed on the way.
The short version: the API whole with a fresh schema, the provider adapters and their tests, the naming and path rules, the PWA, brand, CSP and tooling, the sync engine behind a document seam (§7, "Sync engine"), and the web app's store, sync layer and connect screens over it; not the markdown pipeline, the editors or any notes-only feature.
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
- Adjustment layers that act on every layer below them; a filter on a group is the same thing in SVG's own words (§3, "Layers").
- A phone editor and a desktop editor; there is one, placed by size class (§7, "The interface").

## 15. GitHub setup

As skysa-notes: `main` protected, CI required (`verify`, the changeset check, generated files, the size budget, the minimum Node version), the CLA check on pull requests, Dependabot for the workspace, `CODEOWNERS` at the root.
