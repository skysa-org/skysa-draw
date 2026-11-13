# skysa-draw — Architecture and decisions

This file is the source of truth for how the app works and why.
It is kept current: when a decision changes, this file changes in the same pull request, and the record of the decision in [`decisions/`](decisions/) with it.
[`history.md`](history.md) is how the app was built, phase by phase, and is not kept current.
Open work is in GitHub issues.

A `§` in the code or the records means a section of this file.
Where a section says "see the record", the record holds the whole reasoning and this file holds the decision.

The repository started as a copy of the content-agnostic layers of [skysa-notes](https://github.com/skysa-org/skysa-notes), whose architecture document this one follows section for section, so that a reader of either finds the other familiar; those layers are now the shared kit both apps run on (§12).

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
| Relationship to skysa-notes | A copy of its content-agnostic layers, with provenance (§12; `decisions/0002-carried-over-from-skysa-notes.md`), now the shared kit both apps run on, at one exact version (`decisions/0005-on-the-kit.md`) | Each product exports its own API and core to the parent project, and a fix to a shared layer is made once |

## 2. Architecture overview

Three packages in a pnpm workspace, one version between them (`.changeset/README.md`):

- `packages/core` — framework-free TypeScript that runs in the browser, in Node and in Workers: the drawing file's rules (§3), the names this app gives its files, and what it hands the kit of its own, its folder (`DRAW_FOLDER`, §3) and its format (`DRAW_FORMAT`, §7).
  The paths, the provider adapters (§4, §5), the marker and the protocol are the kit's (`@skysa/storage`, `@skysa/protocol`); core passes the protocol on, the types an operator's policy is written against among it.
  It imports nothing from `apps/*` and nothing of Node or the DOM; ESLint and a second `tsc` pass with no Node types keep it so.
- `apps/web` — the PWA: Vite, React, TanStack Router, Dexie over IndexedDB, vite-plugin-pwa.
  It boots and renders from IndexedDB, talks to the providers directly from the browser for drawing content, and to `apps/api` only to connect an account and to mint access tokens.
- `apps/api` — the Worker entry over the kit's server, `@skysa/server`: a Hono app on Cloudflare Workers with D1 through Drizzle, which holds the storage OAuth flows, per-connection credentials, token minting, the connection and device routes, and the optional change relay (§6).
  Only `src/worker.ts` reads the environment; the server takes its configuration and its seams through `createApp(options)`.

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
  Where a file binds it under two, the id is the one under the first.
- `<title>`, the first child of the root, is the drawing's title, which other tools show.
  It is SVG's `title`, under whatever prefix binds SVG's namespace, after any whitespace, comments or processing instructions; a `title` in no namespace, as 0.1.0 wrote under an `svg:svg` root, is read too, and a rename makes it SVG's.
  A title that could end in two places, as one whose first `</title>` a comment in it holds, is not read: a rename puts a new title ahead of it and takes nothing away.
  One that could is read nonetheless, up to its first `</title>`: one in which an element is left open before it, as `<title>a<b></title>c</b></title>`, which an HTML parser ends at the second and no XML parser reads at all; a rename leaves `c</b></title>` after the new title.
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
  The pixels grow to hold what is written past them, as a Photoshop layer has no edge of its own: in whole pixels of the layer's own grid at the same pixels per unit, the pixels already there kept where they are, to the byte, and only the `<image>`'s `x`, `y`, `width` and `height` changed, in the same command; painting grows them only on the drawing's canvas, a move wherever its pixels go, and only as far as a pixel was left with any alpha (`tools/raster/grow.ts`).
  A pixel edit re-encodes the image whole as PNG; a picture placed from a file keeps its bytes and its type until a pixel of it changes.
  The bytes are inline, a `data:` URL, until attachments beside the drawing arrive (§10), when `INLINE_RASTER_BYTES` decides which go beside.
- `group`: a `<g>` of layers, each by these rules.

What SVG can say about a layer is said SVG's way, where any renderer and any other tool reads it: hidden is `display="none"`, opacity is `opacity`, the blend mode is `mix-blend-mode` in `style` (it has no presentation attribute), a mask, a clip and an adjustment are `mask`, `clip-path` and `filter` referring into the root's `<defs>`, and position is `transform`.
What SVG cannot say is the app's: `draw:name`, the name the user gave it, and `draw:locked`.
A layer's `id` is `layer-<n>`, the smallest `n` free in the document; the history, the masks and the clips refer to a layer by it, and an unnamed layer is shown as "Layer n" and an unnamed group as "Group n" by its number, so each keeps its number when it is moved.
Layers chosen together move as one (`document/arrange.ts`): a layer inside a chosen group goes where its group goes, and the rest keep their paint order among themselves.
A layer moved into or out of a group is drawn where it was: where its new groups place it differently from its old ones, its own `transform` takes the difference as one `matrix(…)`, and where they do not, it is not touched.
Move up and Move down never take a layer out of its group; dragging it in the panel does.

A file from elsewhere has layers by the same rules without a byte written to it: a `<g>` with no `draw:kind` is vector unless its only graphics child is one `<image>`, which makes it raster; a graphics element loose at the root is a vector layer of one element, wrapped in a `<g>` the first time it is edited; a layer with no `id` is given one the first time the file is written; `inkscape:label` is read as a name where `draw:name` is absent, and never written.
A `<g>` is a group only where it says so.

What the body holds beyond this is the editor's business (§7, "The editor"), with two rules.
Adjustments are SVG's own filters, masks and clip paths, so they stay editable and a flattened export is a render.
Nothing is dropped: an element the editor does not know is kept where it was and shown as the browser renders it, except what the sanitizer takes out (§9), which no drawing needs.

Any `.svg` whose root is an `svg` element in the SVG namespace is a drawing to this app (`isDrawingText`), including one another tool made; one with no id is given one on the way in.
A root of more than a million attributes, besides the app's own namespace and id, is not one: each is kept while the tag is read, and the pattern that read it before the scanner ran out of stack before a million with values (decision 0001, amended).
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
- Names are capped so that one conflict suffix always fits in the 255 bytes a filesystem allows (the kit's byte rules, `@skysa/storage`, and this app's `names/slug.ts`): a slug is at most 120 code points and 215 bytes, which leaves room for ` (conflict 2026-09-15T14-32)`, `.svg` and two counters.
- A conflict copy is `name (conflict 2026-09-15T14-32).svg` beside the original, UTC to the minute, with `-2`, `-3` for a second one in the same minute (the kit's `conflictStamp` and `documentNames`, by which `names/drawings.ts` names this app's documents).
  A file that is not a drawing keeps its own extension: `photo (conflict …).jpg`.

The marker carries the folder's layout version, `1` (`DRAW_FOLDER` in `config.ts`; the kit's `parseMarker` reads it); a client that finds a higher one opens the connection read-only rather than writing a layout it does not understand.

## 4. Provider adapter interface

Every provider implements one interface, `StorageProvider`, and the sync engine talks to nothing else.
It is the kit's (`@skysa/storage`), with its errors and the contract suite every adapter passes ([kit §4](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#provider-adapter-interface)).

## 5. Provider specifics

The adapters are the kit's (`@skysa/storage`), and so is what each provider does that the others do not ([kit §5](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#provider-specifics)).
This app hands them its folder, with its marker and Drive's tag on it (`DRAW_FOLDER`, §3), and the format of its drawings (`DRAW_FORMAT`, §7, "Sync engine").

### 5.1 Google Drive
The kit's ([§5.1](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#google-drive)), with the scope `drive.file` and the folder found by its tag, `drawapp`, never by name; a folder the app has left is tagged `drawappLeft`.
A drawing is uploaded as `image/svg+xml; charset=UTF-8`.
Registration: `google-oauth.md`.

### 5.2 OneDrive (Microsoft Graph)
The kit's ([§5.2](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#onedrive-microsoft-graph)), in the app's special folder, `approot`.

### 5.3 Dropbox
The kit's ([§5.3](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#dropbox)), as an App-folder app.

### 5.4 WebDAV
Deferred indefinitely, as in skysa-notes: it needs a proxy on the Worker, which would stream content through the server this architecture keeps content away from.
The design as it was planned is the kit's ([§5.4](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#webdav)).

## 6. Backend

The backend is the kit's: `@skysa/server`, a Hono app on Cloudflare Workers, built as a library ([kit §6, "Backend"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#backend)).
The design that was here is there: the composition root and its seams (entitlements, connect codes, rate limits, the relay), provider enablement, the storage OAuth flows, the server's half of the per-connection credential, the data model, the endpoints and the change relay.
This app's part is its deployment, in `apps/api`:
- `src/worker.ts` is the default Worker entry, and the only module here that reads the environment.
  It builds the config through the server's own `parseEnv`, logs what `envWarnings` says of it, hands it to `createApp` with the relay's Durable Object when `RELAY` is on, and answers with `misconfigured` while the config is wrong.
- `@skysa/draw-api` and `@skysa/draw-api/relay` (`src/index.ts`, `src/relay.ts`) are the server's names as this package has always offered them: the stock entry imports them, and so does a deployment's own, so an operator who needs different behavior still writes an entry rather than a fork (`self-hosting.md`).
- `wrangler.toml` binds D1, whose migrations are the kit's (`migrations_dir = "node_modules/@skysa/server/migrations"`), and serves the SPA from the same Worker through `[assets]`, so `/api/*` and the app share an origin.
  A database 0.1.0 made is reset onto them rather than migrated (`self-hosting.md`, "A database from 0.1.0").
  It sets no `nodejs_compat`: the Worker, the server in it included, uses only Web Crypto and fetch, and lint and `tsconfig.src.json` hold the entry to that.

What the kit's section decides that this app is built around, named here because this app's documents cite it by name:

**No identity.**
A connection is one storage account, reached by the devices that hold a credential for it.
Nothing aggregates connections under a person, and there is no sign-in.

**Per-connection credentials.**
The device generates 32 random bytes (`sk1_…`), keeps them in IndexedDB, and sends only their SHA-256 ([kit §6](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#per-connection-credentials)).

**Seams.**
`createApp` takes an `EntitlementProvider`, a `RateLimiter` and a relay; the defaults allow everything and limit nothing.
A parent project supplies its own and never edits this repository (§13).

**Change relay** (optional, `RELAY=true`).
A Durable Object per connection that tells the connection's other devices "something changed", nothing else ([kit §6](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#change-relay)); `self-hosting.md` says what it costs.

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
  For a big text the id is written in and the hash worked out in a worker (`store/digest.ts`), with the kit's `contentHash` on the page where there is no worker, it fails, or it has not answered in 30 s; under 64 KB the page does it, which costs less than the post.
  What is stored is the text as the worker hands it back, the same characters held a byte to a character where they are all ASCII, since a text the editor serialized can be held two bytes to a character and Chrome's IndexedDB writes and reads such a string many times slower: 60 ms a save, against 4, for a drawing of 15 MB.
  A queued write carries no content, so a save writes the text once, into the drawing's row.
- `renameDrawing`: into the file's `<title>` and into the filename; a `move` queued where the name changed, and a `write`.
- `deleteDrawing`: a tombstone now (`deletedLocally`), shown nowhere; its writes withdrawn and a `delete` queued, which the push sends where the provider has the file and settles with nothing sent where it never did; the pile's tombstones are dropped when the pile goes into a connection.
- `createFolder`: refused where the parent has the name however it is cased.
- `createDrawing` takes a `filename` chooser, run inside its transaction, for a name that is not the title's slug: a conflict copy's.

### Sync engine

The engine is the kit's (`@skysa/sync`, [kit §7](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#sync-engine)), and so is the scheduler that runs one per connection (`@skysa/client`).
This app hands them what is its own:

- **The format**, `DRAW_FORMAT` (`packages/core/src/drawing/format.ts`), the one thing the engine knows of what a drawing's file holds: the id a file claims (`readDrawingId`), a conflict copy's contents (`conflictContent`: the local text with a new `draw:id`, by `withDrawingId`), and whether a `.svg` is a drawing at all (`isDrawingText`), so one that is not an SVG document is `UnreadableError`, as §3 says.
- **The folder**, `DRAW_FOLDER` (§3), which the provider factory hands the adapters.
- **The store.** The Dexie `SyncStore` is `apps/web/src/sync/store.ts`, speaking the kit's words at its edge (`SyncNote`, `noteId`) and this app's rows inside (`drawingId`), held to the kit's contract (`describeSyncStoreContract` from `@skysa/sync/testing`) in `apps/web/tests/sync/syncStore.test.ts`.
  The scheduler's own store is `clientStoreOf` in `sync/dexiePorts.ts`, over the same database, held to the kit's client suites in the `*.dexie.test.ts` files.
- **The lock**, `skysa-draw:sync:<connectionId>` (`sync/lock.ts`), the Web Lock one tab syncs a connection under, named as the tabs of every earlier build name it.

`sync/drawingsSync.ts` makes the scheduler over this app's database, with the files beside drawings read through the session it runs; `sync/runtime.ts` starts it, from `main.tsx`.
A file another tool made keeps its bytes when it is pulled: the engine gives it an id without writing it in, and the first save writes it.
The engine's conflict copy keeps the drawing's `<title>` and takes a new `draw:id` only, where the editor's own copy (below, "Conflict rule") is retitled `<title> (conflict <stamp>)` in the catalog's words; making the two agree is a known gap (§10).
No hidden path syncs (`syncsHidden` in `config.ts` answers no to every one), unlike skysa-notes' scratchpad and vault.
The rest of the web sync layer is this app's: the account and its source names, held edits, and the tabs that stand against each other.
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
Layers are chosen in the panel with the keys users know, several at once (`layerSelection.ts`), and the chosen are moved, grouped, deleted and duplicated together, each as one command; merge down, rasterize and clip stay the active layer's, and are not offered while more than one is chosen.
The panel drags the chosen to another place in the stack, into and out of groups (`panels/layerDrop.ts`).
One layer is active, always among the chosen; tools act on it, a tool that does nothing on its kind says so and is not available, and the tool bar shows only the tools that act on it, with the tool in hand kept, faded, where it does not (`availableOn`).
The tool bar holds the tools in Photoshop's groups and order, a light rule between each two (`tools/groups.ts`), and folds the largest groups into one button each, with the rest in its menu, only where the bar it is measured in is too short to show them all (`panels/ToolGroups.tsx`; `decisions/0004-the-interface.md`, "The tool bar").

**Tools.**
One tool is one tool: the same name, the same key and the same options whether the active layer is vector or raster, doing on each what a user of that tool expects (`decisions/0004-the-interface.md` lists them).
Pointer Events alone drive them, in user units through the viewport's inverse transform, with `pressure`, `tiltX` and `tiltY` where the device gives them and `getCoalescedEvents()` so a fast stroke keeps every sample.
On a vector layer a stroke is a `<path>`, a brush stroke a filled path whose width follows pressure, a shape its own element, and selection, move, resize and rotate are `transform`s.
On a raster layer a stroke is painted on a canvas as large as the layer's pixels may grow to on the drawing's canvas, shown live on a canvas over the viewport clipped to the drawing's canvas on the screen (`LiveCanvas`, `canvasClip`), since the drawing is cut to its canvas, and written into the `<image>` when the stroke ends, the pixels grown to hold it; the encoding is asynchronous and a save waits for it.
While that canvas shows a layer's paint, a stroke's, a smudge's or a move's, the layers painted after that one are lifted over it, so the paint is under them as it will be once it lands (`viewport/cover.ts`): they are shown on a copy of the drawing on a stage of their own over the canvas (`StageCover`), every other layer of the copy made clear, and made clear in the drawing by a rule beside its root in the shadow root, as the move's hole is, so the root is never touched and a save meanwhile writes the drawing as it is.
The copy is shown once its pictures have loaded, in the same turn as the rule goes in, so a lifted layer is never shown twice nor blinks out, and the live canvas waits with it, so what is painted meanwhile shows a frame late rather than over the layers it will be under.
Only layers painted plainly over what is under them look the same on a copy, so only a run of them at the top is lifted: one blended with what is under it, or with something in it that is, stays under the paint with everything below it, a group with an opacity, a blend, a mask, a filter or a clip is lifted whole or not at all, a layer clipped to the one below it only with that one, and nothing is where the root itself has such an effect.
Remove's highlight is no layer's paint and stays over every layer.
The paint bucket, Fill…, Remove and the smudge take the canvas past the layer's pixels for transparent pixels of the layer, as Photoshop does.
Writes land in the order the strokes were made, whatever order their encodings finish in, and a stroke that changed no pixel writes nothing, so a picture keeps its bytes until a pixel of it changes (§3).
The encoding is done off the page's thread, in a worker of the app's own (`drawing/pictures/`): the surface takes a snapshot of its canvas with `createImageBitmap` as the write is asked for, so the pixels are those of that moment, and the worker draws it on an `OffscreenCanvas` and encodes it as a PNG `data:` URL, byte for byte the one `toBlob` writes, partly transparent pixels included.
On a layer 4000 px across the page's own `toBlob`, which encodes in idle slices of the page's thread, landed a stroke some 7 s after it ended; the worker lands it in under half a second.
Where there is no worker, or it fails, or it has not answered in 10 s and a second more for each megapixel, the page encodes the snapshot itself, as it did before, so a stroke is never lost and the writes after it are never held behind it.
Adjustments are a stack of SVG filter primitives on the layer, each previewed live while its slider moves and made one command when it is let go, as opacity is.
Crop is the canvas's `viewBox`, and `width` and `height` where the file has them, scaled in their own unit; nothing is resampled, and the viewport refits to the new box.
The Image menu's operations are Crop's kin (`document/canvasOps.ts`, each one command): Canvas size sets the box about its anchor in whole units and moves nothing drawn, and Trim and Reveal all set it to what is painted, measured as alignment measures it (`layerExtentIn`), or, for Trim by a corner's color, by a render of the drawing as an export makes it.
A turn, a flip and Image size put one matrix in front of the `transform` of every child of the root that draws (`document/canvasTransform.ts`), so nothing is resampled, a quarter turn or a flip stays in whole numbers, and a turn keeps the canvas's top left corner where it was; Arbitrary turns about the canvas's middle and grows the box to hold the turned one.
A layer that draws nothing yet is left as it is, so a new layer is upright, and a `<use>` that draws something the matrix moved is given its inverse, so it shows that thing where it is drawn.
Image size with Resample draws each raster picture again at the new size, one at a time, as a PNG, keeping a pixel to a unit; without it a raster layer is stretched by its transform, as a Free Transform stretches it.
Image size, Trim and Reveal all are jobs the document waits for, dropped with a notice if the drawing changed meanwhile, as merge's render is.
A `transform` on a raster layer is a transform, never a resample, until the user rasterizes it.
What a group holds shares its lock and its visibility, as a locked group in Photoshop locks every layer in it: every tool's guard (`guardLayer`, `guardedLayer`) refuses a layer locked or hidden, itself or by a group around it, and names the nearest that holds it (`tools/common/held.ts`), a lock still letting a tool read the pixels; the selection's actions are offered as the guards allow.
The pen draws a `<path>` of cubic segments, a click a corner and a drag a smooth point; a click on the first point closes it, a click on the last or Enter finishes it, and Escape keeps a path of two points or more, as Illustrator and Figma do.
The node tool moves a path's anchors and handles and inserts a point where a segment is pressed, and turns a shape (`rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`) into a path on its first edit, keeping its id and its other attributes.
Path data is read as a browser reads it, every command, with arcs as cubics, and written back as `M`, `L`, `C` and `Z` to two decimals (`tools/vector/path/`).
The text tool types into a field over the canvas, opened as the pointer lifts so a pinch opens none, and writes one `<text>`, a `<tspan>` to a line, in one command; its face is named (`sans-serif`), so it is the same in the editor, in a thumbnail and in another tool.
What a tool adds to a vector layer is upright, unmirrored and at the options' sizes on the canvas, whatever the layer's placement (`newElementSpace` in `tools/vector/guard.ts`): on a layer only moved it is written in the layer's units with no `transform`, as ever, and on one turned, flipped, scaled or skewed, by the Image menu or a Free Transform, in the drawing's units under a `transform` that is the inverse of the layer's placement, to nine places, as Inkscape draws into a transformed group.
The text tool's size is the size a text is seen at, through its own `transform` and its layer's, and the vector tools find an element by its box in the drawing's units, its layer's matrix and its own boxed as one, so an upright element on a turned layer is pressed, filled, erased and selected by its own box.
A tool may ask for another (`ToolContext.useTool`): the viewport asks the frame, which holds the tool in hand, and once the new tool is in hand and the last put down, hands it the element to edit (`ToolBehavior.edit`, `viewport/toolHandover.ts`).
The tool in hand is told when the options change (`ToolBehavior.optionsChanged`), with a context that has them, so what it holds open follows; a tool may set them too (`ToolContext.setOptions`), as the text tool does with an edited text's own size and fill.
The text tool's field stays open while the focus is where the options are set (`data-tool-options`, `tools/optionsRegion.ts`), and shows a new size or fill at once.
While the field is open on a text, the text is hidden by a rule beside the root in the viewport's shadow root, never by a change to the drawing, and the field follows it through an undo or a redo, to the copy an undo puts in its place, writing nothing once it is gone (`tools/vector/textHide.ts`).
An edited text's `font-size` and `fill` are written in the same one command as its words, only those changed while the field was open and different from the text's own, as attributes, and taken out of its `style` and its `<tspan>`s.
A double press with the select tool opens a text in the text tool with the caret at the press, and a path, a shape, or the path under the press in a group, in the node tool (`tools/vector/doublePress.ts`).
The marquee, the lasso and the magic wand make the area selection, a closed path in user units that outlives the tool: on a raster layer every painting tool paints inside it, the fill floods only inside it and Delete clears it; on a vector layer it selects the elements it touches and is dropped.
Each makes its outline in one of Photoshop's four modes, its first option or Shift, Alt or both held as it begins (`areaModeOf`, `drawing/keys.ts`): a new selection, or added to, subtracted from or intersected with the area there (`combineAreas`, `tools/raster/areaOps.ts`), keeping the area's feather.
A key that chose the mode does nothing else in that drag; pressed only after it began, Shift keeps the marquee square and Alt draws it from its center.
A click makes nothing: in a new selection it drops the area, and in the other modes it leaves it as it is.
Adding to a plain area is the two outlines as one subpath list, a union under `nonzero`, exact; subtracting and intersecting are worked on a mask of cells and traced back.
An inverse is met by its outline alone, with no canvas: adding is an inverse of the outline less what is added, subtracting an inverse of both outlines as one, and intersecting what is added less the outline, a plain area.
With nothing selected, add is new, and subtract and intersect select nothing; an inverse whose outline what is added covers has an empty path, the whole canvas, and its inverse is nothing selected.
The mask (`tools/raster/areaMask.ts`) is one cell a user unit on whole units, filled at the cells' centers by a scanline under `nonzero` with the top-left rule, so a box on whole units comes back exactly and a slanted edge as a staircase, as Photoshop's selection is a mask of pixels.
Past RASTER_MAX_SIDE² cells, the most a raster layer holds, the cells are larger, a whole number of units each.
The cells are traced back as the wand's are, outer loops clockwise and holes the other way, and an outline whose box the other's misses is left as it was.
On a vector layer the same modes meet the elements found with those selected, in paint order (`combineElements`, `tools/vector/region.ts`): new is what was found, add either, subtract what was selected and not found, intersect what is in both.
The magic wand makes the area from a color, as Photoshop's does (`tools/raster/wand.ts`).
A click on a raster layer selects the pixels within the tolerance of the one clicked, by the fill's distance over all four channels, so a click on a clear pixel selects the clear ones.
With Contiguous on, the default, those are the pixels joined to it by their sides, as the fill floods; with it off, every such pixel of the layer.
The mask is traced along the pixels' edges into loops, each straight run one segment, outer boundaries clockwise and holes the other way, so under `nonzero` a ring keeps its hole (`tools/raster/trace.ts`).
The corners come into user units through the inverse of the layer's pixel map, its `transform` included, and are written to two decimals as the marquee writes its own.
Tracing is linear in the mask and never recurses; an outline past a million corners is refused with a notice, since every stroke inside the area reads it again.
Its modes are the marquee's, and a click outside the layer's pixels selects nothing, which deselects in a new selection and leaves the area in the others; a locked layer may be selected from and a hidden one may not, and nothing enters the history.
Since a wand's outline has holes, an inverted area asks the winding, not whether a subpath holds a box, to tell what is in its hole (`reachesArea`).
On a vector layer the wand selects every element of the active layer painted within the tolerance of the one clicked, by its fill where that is a color and its stroke where it is not, a filled element matching only filled ones, as Illustrator's wand does by default; Contiguous does not apply there, and its modes are the marquee's.
Select inverse makes the area the canvas outside the outline, and feather fades its edge over a distance in user units either side of the outline.
Neither is a clip, since a clip cannot take a complement where subpaths overlap: every write through an inverted or feathered area composites by its mask, the outline filled through the canvas's `filter: blur()` at a deviation of half the feather and, for an inverse, taken out of the canvas (`areaMask`).
So a brush stroke, a fill, Delete and the smudge change each pixel by as much as the area covers it, and a feathered edge keeps its partial alpha; where the canvas has no `filter` (Safari before 18) the edge is hard.
The live stroke is exact for a plain or an inverted area, and shows a feather's edge hard, on the outline, until the stroke lands.
The marching ants trace the outline, and for an inverse the canvas's edge too.
Modify… (`modifyArea`, `tools/raster/areaOps.ts`) expands, contracts, smooths, borders or feathers the area, as Photoshop's Select > Modify does, by a radius in whole units held to Photoshop's limits (`MODIFY_LIMITS`: 1 to 500, Border 1 to 200, Feather 0 to 250).
Feather sets the area's feather and leaves its outline as it is; Shift F6 opens Modify… at it.
Expand, Contract and Border measure the exact Euclidean distance between the cells' centers, by the transform of Felzenszwalb and Huttenlocher, linear in the cells, so a corner grown is round (`tools/raster/morph.ts`).
Smooth keeps a cell where most of the square of the radius either side of it is selected, which takes off specks and fills notches; Border is a band the radius wide on the outline, the odd unit inside.
An inverse expands by contracting its outline and contracts by expanding it, so the canvas's own edge stays; its Smooth smooths the outline, and its Border is a plain band on the outline.
Every result keeps the area's feather; one that would leave nothing is not applied, and a notice says so, since an area is not in the history and could not be had back.
On a 4000 × 3000 area each mode and each way takes 100 to 270 ms in Node on an Apple M-series machine, most of it the trace.
Its dialog (`panels/ModifyDialog.tsx`) is given the area and the canvas, and gives back the area made.
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
A marquee or lasso drag that begins inside the area in a new selection, with neither Shift nor Alt held, moves its outline alone; in another mode it makes an outline there.
Transform selection (`viewport/areaTransform.ts`) moves, scales and rotates the area's outline by a box with the select tool's handles (`tools/vector/selection.ts`), its math pure in `tools/raster/areaTransform.ts`.
The outline is absolute, straight and closed, so an affine map of its corners is exact: every sample maps the outline the transform began with by one matrix, written to the area's two decimals, so nothing is rounded twice.
A map that mirrors walks each subpath back, so outlines stay clockwise and holes the other way under `nonzero`.
While it is on, the viewport hands its presses and its hover to the transform in place of the tool in hand, asks no `Tool.pick`, and draws the box on an `<svg>` of its own over the tools' overlay, which a tool empties and the box outlives.
Enter, Escape and the arrows are read before the viewport's other keys (`isCommitKey`), and Ctrl or ⌘ Z and its redo on the window's capture phase, so the frame's undo never hears them while the box is up; the top bar's Undo and Redo ask the viewport's handle first (`ViewportHandle.undo`).
A new tool, another active layer and every other action of the selection's apply it first (`applyingFirst`); an area set by anything else ends it where it is.
The move tool's Auto-select (`tools/common/autoSelect.ts`) picks the layer a press acts on (`Tool.pick`): the topmost, walking the paint order down and into groups past hidden and locked ones, that is more than half opaque under the press as seen.
A vector layer is read by the select tool's own hit (`elementAt`), a raster layer by one pixel (`tools/raster/probe.ts`): from its surface where one is decoded, otherwise from its `<image>` drawn onto a canvas of one pixel, so no surface is made of a layer only looked at.
On a 4096 × 3072 PNG the first read took 66 to 120 ms in Chromium, Firefox and WebKit, the browser's own decode, and every read after it under a tenth of a millisecond, against 89 to 183 ms and 48 MB for a surface.
The viewport asks the tool before the press begins, has the frame make the layer active (`onActivateLayer`), and begins the press with a context of that layer and the behavior for its kind, so the whole press is that layer's before the frame shows it.
Activating a layer is not a command, and a canceled press gives the layer back, and the layers chosen with it (`onSelectLayers`).
With more than one layer chosen, the move tool moves the outermost of them together, whatever the active layer's kind, each by its own `transform`, in one command (`tools/common/layersMove.ts`); a group active alone moves whole the same way.
Each move is a `translate(dx dy)` in front of the layer's transform, in its parent's units, so every layer goes the same distance on the screen, folded into the translate already in front where there is one, so moves do not pile up (`translated`).
A chosen layer that is hidden or locked, itself or by a group around it, or a locked layer inside a group that moves, refuses the whole move, and the first such is named.
Auto-select's press on a chosen layer, or on one inside a chosen group, keeps the choice; on another layer it makes that one active, which chooses it alone (`viewport/chosenLayers.ts`).
The arrows nudge the chosen layers, or a group alone, a user unit at a time, or ten with Shift, since each layer's pixels are its own size.
With one layer, the arrows nudge what a drag would move: an area's pixels, else the elements selected on a vector layer, each by its own `transform` composed as the drag composes it, so they go along the screen's axes whatever the layer's placement (`tools/vector/nudge.ts`), else the layer whole, as Photoshop's move tool moves it.
Each key is one command, as a drag is, and a stroke under way takes the key and moves nothing.
The move tool's options bar aligns and distributes the same layers, as Photoshop's does (`tools/common/align.ts`; `decisions/0004-the-interface.md`, "Align and distribute"): each is measured by what it paints, in the root's user units (`viewport/layerExtent.ts`), and moved by its own `transform` as a drag moves it, all in one command.
With elements selected on a vector layer the move tool would move alone, it arranges them instead (`tools/vector/alignElements.ts`), each measured by its box after its own `transform` and its layer's, moved by its own `transform`, all in one command.
The move tool's drag of elements, its box's resize and turn, its arrows and its alignment change the elements' `transform`s by one command that touches that attribute alone, on the same nodes through an undo and a redo (`transformElements`, `document/elements.ts`), so what was selected stays selected, as in Illustrator, and its box is drawn again after every change to the drawing.
The command keeps only the attribute as it was, or every attribute where the change takes it off, so a nudge held down on a layer of hundreds of strokes costs the history some 80 bytes a step, where an edit of the layer cost two copies of it.
The measures are a promise, since a raster layer's picture is decoded to be measured, and a change to the document before they are in leaves the arrangement undone rather than wrong.
A drag with the move tool snaps, as Photoshop's does with View › Snap (`tools/common/snap.ts`): the box of what moves, the layers' extents together or the elements selected on a vector layer, snaps each axis on its own, its left, center and right or top, middle and bottom, to the same lines of the canvas and of every other layer in sight that neither moves nor holds what moves, and, for elements, of the layer's other elements; the nearest within 6 screen pixels wins, and a magenta hairline on the tool overlay shows each line it holds to.
The layers are measured as the drag begins and join as their measures come in; nothing snaps until the moving box is measured, nor until the pointer has gone 3 screen pixels from the press, so a click moves nothing; Control held suspends it, Snap off measures nothing, and the arrows' nudge and an area's pixels never snap.
While several are chosen, nothing is selected among the active layer's elements: the selection goes as the choice grows, select all outlines with no handles, and a move lets go of it; the area stays.
A selection is dropped when another layer is made active unless it is that layer's own, so the element the press selected stays selected; its box goes with it at once, under a press too, since a press that picks a raster layer draws no box over the old one (`viewport/selectionFollows.ts`), and the area stays.
A selection on a layer that is hidden, or in a hidden group, stays selected with no box and no handles, and Auto-select keeps no handle there; the box comes back with the first movement over the canvas once the layer is shown, as Photoshop's transform controls do (`hiddenAsSeen`, `tools/vector/selection.ts`).
Ctrl or ⌘ A selects all, the elements on a vector layer and the canvas elsewhere, and D drops both.
The selection's actions are one list (`drawing/selectionActions.ts`) built from the area, the selected elements, the active layer and the history; the canvas's context menu and the options strip's selection bar both show it (`decisions/0004-the-interface.md`, "The context menu").
What each action does is the viewport's (`viewport/selectionCommands.ts`), reached through `ViewportHandle.perform`, so a key, a menu item and a bar button do the same thing.
The frame holds the selection (`viewport/selectionState.ts`) and passes it to the viewport, so the bar and the dialogs can see it.
Layer via copy and cut on a vector layer is one command (`document/layerVia.ts`) that keeps only the selected elements in a copy of the layer, and for a cut takes them from the source, and undoes to the file's exact bytes; on a raster layer it is the raster tools' `layerViaArea`.
Arrange, Duplicate and a drag of items in the layers panel are commands on a vector layer's elements (`document/elements.ts`), named by their positions among its own: an arrangement or a move within a layer reorders the same nodes, so what holds them stays selected, a duplicate puts a copy with ids of its own just above each, and a move into another layer is one step of two edits that carry the same nodes, each given the `transform` that keeps it where it is seen, left byte for byte where the two layers are placed alike.
Smudge pushes the layer's own pixels, each dab picking up what lies under the one before, in one command when the stroke ends.
A tool with a size, the brush, the pencil, the eraser, the smudge and Remove, has the brush's outline for its pointer, as Photoshop's Normal Brush Tip (`tools/common/brushOutline.ts`): a circle `size` across in the drawing's user units, drawn on the overlay in them, so as big on the screen as what it paints at any zoom, with a small crosshair at its middle, and the crosshair alone where the circle would be under 6 screen pixels across.
Each is a light halo under a dark hairline, one width on the screen at any zoom (`viewport.css`), and it shows the whole size whatever the pressure.
The overlay it is drawn on, with the area's ants and the transform's box, is on a stage of its own over the live raster canvas (`viewport/StageMarks.tsx`), moved and scaled as the drawing's is, so a stroke being painted is under the outline that paints it, as in Photoshop.
A soft brush's circle is where its paint is half opaque, `(1 + hardness) / 2` of its size (`softEdge`), since the brush is solid to `hardness` of its radius and fades evenly to the edge, which is where its mark is seen to end, as Photoshop's Normal Brush Tip draws one.
A stroke's width follows pressure only from a pen (`followsPressure`), as Photoshop reads it only from a tablet: a mouse says 0.5 whatever it does, which painted every stroke at five eighths of the circle.
It follows a hovering mouse or pen and the stroke, takes a new size at once (`optionsChanged`), and goes when the pointer leaves the canvas with nothing down (`ToolBehavior.leave`, from the viewport's `pointerleave`), on cancel and when the tool is put down; it is never shown for a finger.
The canvas has the tool's crosshair until the outline is first drawn; while it shows and the cursor is the tool's own (`data-tool-cursor`), the system's is hidden, and under Space's hand, a transform's grips or a tool that does nothing on the layer the outline is hidden and their cursor shows.
A size is in the drawing's user units on every layer, whatever its `transform`: a raster stamp is a disk in user units drawn through the map to the layer's pixels (`brushEngine.ts`), as the Remove tool's footprint is, so a scaled, turned or skewed layer gets the ellipse it makes on its pixels and the stroke lands as it was shown; a smudge dab's radius, a vector path's width and the eraser's reach are the size through the layer's scale (`lengthScale`), the mean of the two where they differ.
The Remove tool paints a round, hard brush `size` across over what should go, shown live on the screen canvas as a translucent highlight, and when the stroke ends makes those pixels again from the rest of the layer, as Photoshop's Remove does (`tools/raster/remove.ts`).
Each sample adds the disk where it is and the band from the sample before, through the layer's pixel map and `transform`, so a fast stroke has no gap and a scaled layer gets the ellipse the disk makes on its pixels (`tools/raster/removeFootprint.ts`).
That footprint, kept to the area where one is selected, is the coverage Fill…'s Content-Aware makes again, with its status, Stop, Escape and stale check, and it is laid over the layer by the coverage at full opacity in one command (`makeAgainUnder`, `tools/raster/areaFill.ts`).
A stroke begun while the engine is still making pixels again, for Remove or for Fill…, paints nothing and says so, since whichever landed second would be dropped as stale.
The Red eye tool makes a pupil a flash turned red a dark neutral, in one command, on a raster layer alone (`tools/raster/redEye.ts`, its arithmetic in `redEyeFix.ts`).
A click looks for the pupil in a square 100 CSS px across on the screen around it, the nearest red winning, and lets the pupil grow to a square three times that; a drag keeps both to its box.
A pixel's redness is red's lead over the stronger of green and blue, less green's lead over blue, as a share of its brightness, and a seed must also pass GEGL's red-eye test, `0.5133 · r ≥ g`.
The pupil is flooded from the seed's red through pixels above a threshold Pupil size sets, from the core alone down to a floor that takes a pink rim and stops short of skin and a brown iris; each is moved toward the mean of its green and blue, darkened by Darken amount, by as much as its redness clears the threshold and the area covers it, its alpha kept.
A press that finds no red pupil, or red only outside the area, writes nothing and says so.

**Export** (`drawing/export/`) is a render of the SVG onto a canvas (`<img>` of a `blob:` URL drawn with `drawImage`, the root given the export's pixels as its size) for PNG, JPEG and WebP from 0.5× to 4×, the longer side kept to 16,384 px (`EXPORT_MAX_SIDE`), a JPEG on white unless another background is chosen; and the file itself for SVG.
A picture placed from a file, a paste or a drop is a new raster layer holding the file's bytes as they came, of the type its header says, fitted inside the canvas and never enlarged (`placePicture`); an SVG is placed the same way, as `data:image/svg+xml`, which a browser draws as a picture with no script.

**Still an image.**
A drawing that is not open in the editor, in the list, as a thumbnail, or one the sanitizer could not parse at all, is shown through an `<img>` of a `blob:` URL (`DrawingView`), which renders any SVG with no script running and no reach into the page.

**The transparency grid.**
Behind a drawing, in the editor and as an image, is Photoshop's transparency grid, white and light gray squares (`--checker-grid`), so what is clear or has nothing on it shows as such; it is the page's, never the drawing's, and an export is as clear as the drawing is.
In the editor its squares are 8 CSS px on screen at every zoom: the paper is in the stage the view scales, so its tile is set in user units, 16 px over the scale (`checkerSize`).

### The interface

Decided 2026-11-04; see [`decisions/0004-the-interface.md`](decisions/0004-the-interface.md).

**Size classes.**
The window is `compact` under 600 px wide, `medium` from 600 to 839 and `expanded` from 840, Material's window size classes, read from `matchMedia` by `useSizeClass` (`components/ui/sizeClass.ts`) and nowhere else: a component never asks how wide the window is; the frame places it, and the component fits its container (`@container`).

**One set of components**, `apps/web/src/components/ui/`: `ToolBar` (horizontal or vertical, one tab stop and the arrow keys, as WAI-ARIA's toolbar pattern says), `ToolButton` (a long press for a tool's variants), `IconButton`, `Toggle` (an option on or off, a check box beside its name), `ChoiceButtons` (one of a few options, each by its icon, as the selection modes are), `Panel`, `PanelHost` (a bottom sheet on compact, a drawer over the canvas on medium, a docked column on expanded), `Slider`, `ColorField`, `ColorPair` (the fill and the stroke as one tool button), `Select`, `Menu` and `ContextMenu` (one list, `MenuList`, whose items may open submenus), `DialogForm` (a dialog of the frame's: its groups, Enter and its first focus, Cancel and Apply) with `NumberField`, `SliderField` and `RadioRows`, `Notice`, `ApplyingProvider` with `useApply` (the frame's indicator for work that holds the page), and the icons, drawn by hand at 24 px in `icons.tsx` and looked up by name through `ICONS`.
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
The two colors are one tool button at the foot of the tool bar, on the rail and on compact alike (`ColorPair`; `decisions/0004-the-interface.md`, "The two colors"): its face shows both, and a press opens the color panel and the next closes it (`togglePanel` in `editorState.ts`).
The swap and the reset are the color panel's, in its header, and X's and D's.
The panel lays out each color as Fill… lays out its groups (`.field-groups` in `ui.css`): `ColorField` stacked, its name over its row and the recent colors under it, where a bar has it inline, its name beside its row.
A click in the layers panel chooses one layer, Ctrl or ⌘ adds or takes one out, Shift takes the range from the last layer clicked, Shift with an arrow grows or shrinks it, and Ctrl or ⌘ A chooses every row shown, as in Photoshop and every file manager (`layerSelection.ts`).
The active layer is always among the chosen, tinted with them and marked in the accent, and each chosen row says "Selected" to a screen reader while more than one is.
Layers are dragged by a mouse or a pen on the layer, and by a finger on a grip shown where a pointer is coarse, since a finger on the layer scrolls the list (`panels/useLayerDrag.ts`, one drag for layers and items); a line shows the gap and how deep, chosen by the pointer's x at a group's foot, a group's row lights for into it, and the list scrolls near its edges.
Alt with an arrow moves the chosen a step, into and out of groups, as a drag to the next gap would.
On an item's row, Alt with an arrow moves the item, or what is selected on its layer where the item is among it, a step forward up the list or backward down it among the layer's elements (`arrangeElements`), the selection and the focus going with it.
The panel's head is New, a menu of a vector layer, a raster layer and an empty group, each made above the active layer as Photoshop's Layer › New makes them, then Duplicate, Delete and the layer actions menu; dragging a row is how a layer moves, and the actions menu keeps Move up and Move down, so a layer can be moved without a drag.
The layer actions menu opens over a row too, on a right-click, a long press the browser makes a menu of, the Menu key or Shift F10, choosing the row alone first where it is not among the chosen; it lists only what applies to the layers chosen, unlike the canvas's menu (`decisions/0004-the-interface.md`, "The layers panel's menu").
A group's folder is its disclosure: a button of its own where a layer's row shows its kind, with a caret in the folder that points down while the group is open and across while it is shut, so a group's name lines up with a layer's and no row moves over for it.
An empty group's folder has no caret and is no button, since there is nothing in it to show or hide.
A group collapses by its folder, with Alt every group inside it too, or by the arrows across, as a tree view does; which are collapsed is the editor's state for as long as the drawing is open, never the file's, and changes nothing that is chosen.
A layer's row shows its preview where its kind was, as Photoshop's thumbnail does, a vector layer's with a small mark of its kind on its end corner; a group keeps its folder, as wide as a preview, so every name starts at the same place (`panels/LayerPreview.tsx`).
A preview is the layer as it paints by itself, its own `transform` and `filter` kept and its opacity, visibility, blend and clip to the layer below left out, the canvas fitted in the box over the transparency grid, and an item's picture the item itself with room round it, as Illustrator's layers panel frames each object, since on the whole canvas most items are a dot; it is a standalone SVG copied from the live, sanitized root, never changed in it, with every `<style>` and only the definitions it refers to, and shown through an `<img>` of a `blob:` URL (`panels/layerPreviews.ts`; §9).
One `MutationObserver` per document, shared by every preview shown, traces each change to the layer it is in, or to every preview for a change outside the layers, and builds the marked pictures again 250 ms after the changes stop; a picture whose text came out the same keeps its URL, and every URL is revoked once replaced or no longer shown (`panels/layerPreviewStore.ts`).
A picture in the file's own bytes, a raster layer's `data:` URL of megabytes, is drawn in a preview by a stand-in 256 px on its longer side, decoded once and shrunk by `createImageBitmap` in the surface's picture worker, which reads the `data:` URL into bytes itself (`panels/previewPictures.ts`, `drawing/pictures/`), or through an `<img>` on the page where the worker cannot, for an SVG or a picture not in base64: the SVG a preview holds is then kilobytes, where parsing it whole and decoding every pixel for a 36 px picture stalled the page for 200 ms after each stroke on a layer 4000 px across, and parsed and decoded it all again each time the panel was shown.
The stand-ins are the document's, by the picture's very `href`, so a panel shown again finds them made; while one is being made the picture shown stays as it was, and once no preview draws a picture its stand-in is let go of.
A vector layer of two or more items expands as a group does: its preview is then its disclosure, before the layer's button, with a caret on its start corner that points toward the end of the line while shut and down while open; with one item or none it has no caret.
An expanded vector layer is followed by a row per item, top first, a level deeper, with its own preview, named by its own name or `<title>`, a text by its words, else by what it is (`panels/layerItems.ts`); vector layers start collapsed, and which are expanded is the editor's, never the file's.
A layer of 60 items or more has its rows drawn as a window onto them, every row the same height: those the panel's body shows and six either side, the first and the last, the row with the focus and those either side of it, and the one a drag holds, with the rest stood for by space as tall as they would be (`panels/ItemRows.tsx`, `panels/itemWindow.ts`).
Drawn whole, a layer of a thousand items took two and a half seconds to expand and a third of a second to show each change; drawn as a window it costs what a screenful does.
The arrows walk every row, drawn or not, since the next is always drawn; a screen reader's own browsing, which reads what is in the page, reaches only the rows drawn.
A press on an item's row selects it on the canvas, as Illustrator's layers panel does: its layer active and chosen alone, the move tool taken up unless a tool that selects is in hand, and Shift, Ctrl or ⌘ adding it or taking it out; the row is tinted and says "Selected" while its element is selected, whatever selected it, and the viewport draws a selection made outside it as the tools do (`viewport/selectionShown.ts`).
A pointer's press on an item's row, and a drag of items, then give the keyboard to the canvas's region, so the arrows nudge what was selected, while Enter or Space on a row the keyboard reached keeps it there, where the arrows walk the rows (`panels/useItemRows.ts`).
A drag of layers over items' rows is under their layer; the arrows up and down walk them, right opens a vector layer and then goes to its first item, and left shuts it and from an item goes back to its layer.
An item is dragged as a layer is, by its button or by its grip at the end of its row, with what is selected on its layer where it is among it, else alone, selected as the drag begins; it lands in a gap among the items of a vector `<g>` that is not held, its own or another, or on such a layer's row, lit, on top of its elements, which is how it reaches a collapsed layer or one of a single element, and nowhere else; what moved is then selected where it went (`panels/itemDrop.ts`, `document/elements.ts`).
A right-click on an item, a long press the browser makes a menu of, the Menu key or Shift F10 opens the item's own menu, the very list the canvas's menu shows, the item selected alone first unless it is among what is selected (`panels/useItemRows.ts`).
The items of a layer that is held, locked or hidden, itself or by a group, are shown muted and walked by the arrows, but a press selects none of them and says why as a tool does, and they open no menu, are not dragged and take no drop.

**Work that holds the page.**
Work on a whole layer or on the drawing that reads or writes every pixel is done under the frame's indicator, through `useApply()` (`components/ui/Applying.tsx`): Image size with Resample, Trim, Reveal all, Place picture, Merge down, Modify… but Feather, and Fill, Clear and Layer via copy or cut on a raster layer, each measured to hold the page 300 ms or more on a 4000 × 3000 layer at a quarter of a desktop's speed.
A turn, a flip, a rotation, a canvas size, a rasterize, an adjustment and a duplicate took a frame or two even there, and are done plainly.
The indicator covers the window in the top layer and takes every press and key, so no edit lands in the middle of the work; it has no close control, and it goes when the work does, or after a minute of work that never settles.
It is in place at once and the work begins two frames later, so the browser has drawn it before the page is held; it is seen, by a fade the compositor runs while the page is held, and said politely in the operation's own words, only once the work has gone on 300 ms, and once seen it stays 300 ms, so quick work never flashes it.
Content-Aware keeps its own line over the canvas, with Stop, since its worker leaves the page free while it works; a stroke is never under the indicator, since what follows a stroke is done in workers (§7, "The editor").

**Input.**
Pointer Events only, `touch-action: none` on the canvas; a pen draws, a finger draws unless a pen is down (palm rejection), two fingers pan and pinch to zoom, a two-finger tap undoes and a three-finger tap redoes; a wheel scrolls, with Ctrl or ⌘ zooms, and Space held pans, except on a control the keyboard brought the focus to, which Space presses (`isHandKey`, `viewport/pointerPressed.ts`).
Keys on every size, since a tablet may have a keyboard: a letter per tool and the editing keys users know, in one map (`drawing/keys.ts`).
`prefers-color-scheme` and `prefers-reduced-motion` are honored through the tokens (`styles/tokens.css`); safe areas through `env(safe-area-inset-*)`; the canvas draws at `devicePixelRatio`.

### The app's words

Carried over from skysa-notes.
Every word the user reads is in the English catalog, `apps/web/src/i18n/en/`, as whole sentences with `{placeholders}` and `{ one, other }` for a count, looked up by `t('…')`; `rich()` renders a message with `<tags>` around words.
`tests/i18n.test.tsx` holds every message to what a translation has to keep.
The catalog, the code and the docs are US English; British English, if it is wanted, is a catalog of its own (`en-GB`), not a change to this one.

## 8. PWA specifics

The service worker and the manifest are built by the kit's `@skysa/pwa` from what this app hands it (`PwaApp`, made in `apps/web/pwaApp.ts`) and from its brand (below).
How they are built is [kit §8](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#pwa-specifics): `generateSW`, the app shell precached, `NetworkOnly` for `/api/*` and the provider origins so drawing content never sits in the HTTP cache, nothing inline written into the page (§9), a waiting worker that takes over only when the user says (`registerType: 'prompt'`, so a new build never swaps itself in under a half-drawn stroke), and the checklist a browser applies before it offers to install, which is a test there.
What follows is this app's own.

- `UpdatePrompt` offers the reload; its `beforeUpdate`, which the root route hands it, pauses syncing in every tab first (the kit's `makeWay`), so the new build can take over at once.
- The app has one route, `/`, and what it opens is in the query (`/?f=…&d=…`): the shell answers it, and any other path on the origin is left to the network, so an operator's page beside the app opens as itself.
  `DRAW_PWA` in `pwaApp.ts` hands that route to the build, and `tests/pwa.app.test.ts` checks every route the router has against it.
- It is no share target.
- What the open drawing holds is written before anything acts on what the device holds (`store/heldEdits.ts`).
  The session in `drawing/useOpenDrawing.ts` registers with `beforeClosing` while a drawing is open, and once it closes until its last save has settled.
  Asked to settle, it waits for a copy it is keeping, or one its pending save sets off, writes that save, and tries once more an edit a save before left behind.
  It answers with the drawing's `drawingRef` while the store has still not taken the edits, so a source let go keeps that drawing's rows and an export says it is incomplete.
  Edits held for a drawing deleted elsewhere, with no new drawing taken in its place, are named by the drawing as it was, so that its own source counts them and no other does.
- A newer build in another window asks for the database: this one writes what the editor holds, closes for good (`store/staleTab.ts`), and says so over the page (`components/shell/StaleTabGate.tsx`).
  The notice covers the window in the top layer, as work under way does, and everything else in the page is inert behind it, the sheets and drawers in their portals with it, and hears no key, paste or drop; its answer is Reload.
  It can be put aside to export the drawing, under a bar that goes on saying the window cannot save, along the window's foot with the new build's and under any sheet or drawer.
  A window whose own upgrade an older one holds up says it is waiting.
- The browser is asked to keep the store (`navigator.storage.persist()`, `store/keeping.ts`) when the first drawing is made in the device's own library, once per device, since Firefox answers with a prompt, and again when the app is installed, which Chromium weighs.
  The storage panel says, while the device's own library holds anything and the browser has not agreed, that the drawings may be cleared.

**Brand.**
What the app is called and how it looks come from a `brand.json` at build time: the default brand in `apps/web/brand/` ("Draw", in gray, the pen-stroke icons drawn by `brand/icons.mjs`), or a deployment's own, pointed at with `DRAW_BRAND`.
The default is the app's, handed to the build (`DEFAULT_BRAND` in `pwaApp.ts`), and `tests/brand.app.test.ts` holds it to what is said here.
Name, short name, description, colors for both themes, six icons, optional fonts; the kit reads and checks it, stopping a build with a brand that would install without its icon, and its JSON Schema is the kit's (`@skysa/pwa/brand.schema.json`).
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
  The layers panel's previews are `<img>`s of `blob:` URLs too, each a standalone SVG copied from the sanitized root (`panels/layerPreviews.ts`), so nothing of the drawing enters the panel's DOM; a raster picture's stand-in is decoded in a worker from its own `data:` URL's bytes, read there without a `fetch`, which `connect-src` refuses, or by an `<img>` that never enters the page, and drawn on a canvas the picture cannot taint.
  The sanitized drawing is mounted in a shadow root, so its `<style>` cannot restyle the app or lay a `position: fixed` box over it (§7, "The editor").
  `connect-src` and `img-src` say where an `<image>` may load from; a drawing from elsewhere may name any `https:` picture, as SVG does.
- The page's workers, Content-Aware's (`inpaint.worker.ts`), the pictures' (`pictures.worker.ts`) and the hash's (`digest.worker.ts`), are module files of the app's own origin, which `worker-src 'self'` allows, so nothing is added to the policy; none of them fetches anything.
- `connect-src` lists this origin and the provider hosts the browser syncs with directly, and nothing else; `tests/csp.test.ts` runs each adapter and checks every host it asks.
- `Strict-Transport-Security` for two years on this host alone; `frame-ancestors 'none'`; `form-action 'self'`.
- The credential is sent only as its SHA-256; the server never sees the plaintext (a test greps every response in the flow for a known secret).
- Refresh tokens are sealed in D1 under `SECRETS_KEY` and decrypted only in `POST /api/token`.
- `Cache-Control: no-store` on every API response; `hono/csrf` on the same-origin routes; the flow cookie is `__Host-`.
- No drawing content and no file names reach the Worker, the relay included.
- The kit's adapters decode a drawing strictly as UTF-8 and refuse a NUL, and `DRAW_FORMAT` refuses a `.svg` that is not an SVG document, so a binary or a text misnamed `.svg` is unreadable rather than rewritten.

## 10. Build record

[`history.md`](history.md), by phase.
What comes next, in order:

1. Attachments beside a drawing (§3), which the engine moves with it, and with them `INLINE_RASTER_BYTES`.

Known gaps in what is built, each for an issue:

- Tested under jsdom, which has no 2D canvas, no `getBBox`, no `DOMMatrix` and no stylesheets from an SVG `<style>`, and driven once by hand in headless Chromium under the real Content-Security-Policy (vector and raster strokes, smudge, pen, text, merge down, rasterize, undo, PNG export, the frame at three widths); not yet on a touch screen, with a stylus, or in Safari or Firefox.
- Renaming a drawing reopens it and loses its undo history, since `renameDrawing` rewrites the row's text.
- The library drawer's own rows (`Sidebar`, `DrawingList`) are below the 44 px target.
- The brush's outline's crosshair, and whether its circle is too small to show, are read at the zoom of the pointer's last move, so a zoom by the keys or the wheel with the pointer still shows them at the old zoom until it moves; the viewport telling the tool in hand of a new view would fix it.
- A stroke still under way when the editor reopens on a change from elsewhere is lost; an undo pressed while a raster stroke is encoding is overtaken when the stroke lands.
- A drawing's `@font-face` does not apply inside the shadow root in Chromium, so its embedded fonts may not show in the editor.
- Deleting a layer leaves the clips that name it, and those layers show nothing until their clip is released.
- A clip follows only the clipped layer's own `transform` (`decisions/0003-layers.md`), so once the layer below is dragged into another group, moving the group that holds only one of them moves the clip's shape; a loose clipped element moved by the vector select tool is wrapped first, and its clip moves with it.
- The Image menu's turns, flips and Image size leave the root's own `mask`, `clip-path` and `filter` as they are, do not see a `transform` set in a style or a stylesheet, and do not follow a `textPath`, `feImage` or `mpath` reference; Image size with Resample redraws a picture with the browser's smoothing, which Firefox does not refine.
- The pen finishes a path when the tool changes by watching the overlay being emptied, and listens for Enter and Escape on the document between clicks, since the viewport tells a tool only about strokes; a tool key pressed during a pen drag leaves the path open until Enter or Escape; a `finish` member of the tool contract, called by the viewport, would replace both.
- A save that arrives after its source was let go is refused, where skysa-notes makes the drawing again under a detached source (`bringBack`, `ensureDetached`); `settleEditors` covers a release, not an undo that outlives it.
- Per-source preferences (skysa-notes' `sourcePrefs`) are not kept.
- A save, or a new drawing, the store refuses for any reason but a delete says nothing on screen (`drawing/useOpenDrawing.ts`); a refused save is tried again at the next change, or when the editor is asked to settle, and is counted as held until it goes in, or until the editor closes and it goes with it.
- An undo back to the text the drawing opened with, or to one this session saved before, counts as saved though the row may hold a later save, so a refused save of it is neither named when the editor settles nor kept under a change or a delete from elsewhere (#13).
- Web Locks, BroadcastChannel, the wake lock, the relay WebSocket and IndexedDB are tested only through fakes and fake-indexeddb, and no provider has been connected for real.
- A conflict copy the sync engine makes keeps the drawing's title, so the list shows two drawings by one name until one is renamed; the store contract pins the copy's text to `conflictContent`, so retitling it means giving the contract the store's words for the title.

## 11. Repo layout

```
apps/
  api/            The Worker over the kit's @skysa/server: src/worker.ts (the only env reader),
                  src/index.ts and src/relay.ts (the server's names, for a deployment's own entry),
                  wrangler.toml (D1 migrations from node_modules/@skysa/server/migrations)
  web/            Vite + React: src/routes/ (file routes; routeTree.gen.ts is generated),
                  src/store/ (Dexie), src/components/ (ui/ the shared set; shell/, sidebar/, list/, sources/, account/),
                  src/drawing/ (the editor: document/, tools/, panels/, Editor.tsx, Viewport.tsx, keys.ts),
                  src/i18n/, src/sync/ (the kit's scheduler over this app's SyncStore and ports),
                  src/errors/, src/hooks/, src/styles/,
                  brand/ (default brand, icons.mjs), pwaApp.ts (what the kit's @skysa/pwa builds from),
                  public/_headers, scripts/size.mjs (the size budget, measured by @skysa/pwa/budget), tests/
packages/
  core/           src/config.ts (DRAW_FOLDER), src/drawing/ (the file; format.ts is DRAW_FORMAT),
                  src/names/ (slugs, drawing names), src/files/pictures.ts, tests/
docs/             this file, history.md, decisions/, self-hosting.md, google-oauth.md
.changeset/       one version for the three packages
.github/          CI (verify, changeset check, generated files, size, minimum Node), release, CLA
eslint.config.js  the kit's lint, skysa() from @skysa/eslint-config, with this app's own blocks;
                  tsconfig.base.json and .prettierrc.json name the kit's settings, and
                  tsconfig.json holds vitest.config.ts, which the kit's lint reads with types
```

Layers, enforced by ESLint's `no-restricted-imports`: core uses of the kit only `@skysa/protocol` and `@skysa/storage`, and in it `names/` sits below `drawing/`; in the web app, `lib/` imports nothing of the app, `store/` imports neither the UI nor the sync layer nor the editor, `errors/` and `hooks/` import neither the store nor the sync layer nor the UI, `sync/` never imports the UI, and `drawing/` (the editor) never imports routes or the sync layer.
Below the sync layer, the kit's client (`@skysa/client`, which holds the scheduler, the API client and the relay) gives only its emitter and store, and what each layer names besides.
The test doubles are the kit's (`@skysa/storage/testing`, `@skysa/sync/testing`, `@skysa/client/testing`), and nothing the app ships may import them.
The lint's shared rules, the compiler's settings and Prettier's are the kit's, `@skysa/eslint-config`; `eslint.config.js` hands its `skysa()` this app's own blocks: the layers above, core's bans on Node, on `apps/*` and on the browser's globals, the Worker entry's rules (no Node, no `cloudflare:*`, `process` and `console` in `worker.ts` alone; §6), the app's words (§7) and the canvas's carve-out; `tsconfig.base.json` and `.prettierrc.json` name the kit's.

## 12. Carried over from skysa-notes

Decided 2026-11-13; see [`decisions/0005-on-the-kit.md`](decisions/0005-on-the-kit.md), which says what went where, what this app hands the kit and keeps, and why a 0.1.0 server database is reset.
It supersedes [`decisions/0002-carried-over-from-skysa-notes.md`](decisions/0002-carried-over-from-skysa-notes.md) (2026-11-03), which lists each layer as it was copied, its source commit and what changed on the way.
What was copied, in short: the API whole with a fresh schema, the provider adapters and their tests, the naming and path rules, the PWA, brand, CSP and tooling, the sync engine behind a document seam (§7, "Sync engine"), and the web app's store, sync layer and connect screens over it; not the markdown pipeline, the editors or any notes-only feature.
Those layers have moved into the shared kit, [skysa-org/skysa-kit](https://github.com/skysa-org/skysa-kit) ([skysa-notes' record 0018](https://github.com/skysa-org/skysa-notes/blob/main/docs/decisions/0018-the-shared-kit.md), step 4): the server (§6), the protocol, the adapters and the naming rules (§4, §5), the sync engine and the sync client (§7), the PWA build (§8) and the lint's shared rules (§11); not the slug, the attachments' names or this app's own names (`packages/core/src/names/`).
A fix to any of them is a kit PR, and this app takes it by moving its pin, one exact version for every kit package (`apps/web/tests/kitVersion.test.ts`).

## 13. Distribution and licensing

**Repo.** `github.com/skysa-org/skysa-draw`, public, AGPL-3.0-only (`LICENSE` verbatim, `NOTICE` the copyright notice, `TRADEMARK.md` for the names, two CLAs).
The three packages share one version and one `vX.Y.Z` tag cut by `release.yml` from Changesets.

**The parent project.** A cloud deployment consumes this repository as a git submodule, as it does skysa-notes: it calls `createApp` with its own `EntitlementProvider`, `RateLimiter` and relay, sets `ENABLED_PROVIDERS` and `RELAY`, and builds the web app with its own `DRAW_BRAND`.
Nothing of that deployment is in this repository, and nothing in this repository names it.

**Self-hosting.** `self-hosting.md`: one Cloudflare account, one Worker, one D1 database, the provider registrations, the secrets.

**Dependencies.** MIT, Apache-2.0 or ISC only; a new one says why in its pull request.
The kit's `@skysa/*` packages are the one exception: AGPL-3.0-only like this repository, under the same CLA, and pinned to an exact version ([skysa-notes' record 0018](https://github.com/skysa-org/skysa-notes/blob/main/docs/decisions/0018-the-shared-kit.md)).

## 14. Not planned

- Sign-in, accounts, or anything that knows two connections belong to one person (§6).
- A format of the app's own; a drawing is SVG and stays one (§3).
- Collaborative editing; the relay says "something changed" and nothing else.
- WebDAV (§5.4).
- Adjustment layers that act on every layer below them; a filter on a group is the same thing in SVG's own words (§3, "Layers").
- A phone editor and a desktop editor; there is one, placed by size class (§7, "The interface").

## 15. GitHub setup

As skysa-notes: `main` protected, CI required (`verify`, the changeset check, generated files, the size budget, the minimum Node version), the CLA check on pull requests, Dependabot for the workspace, `CODEOWNERS` at the root.
