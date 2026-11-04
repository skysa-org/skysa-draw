# skysa-draw

**skysa-draw** is a local-first drawing and image editing PWA that syncs to a dedicated, app-owned folder on your own Google Drive, OneDrive, or Dropbox. Every drawing is a plain `.svg` file in an ordinary directory tree, so your drawings stay viewable, portable, and editable by any other tool, and folders are simply folders. The app reads and writes entirely from IndexedDB, so it works fully offline and syncs in the background when a connection returns; when you connect a provider your drawings go straight from the browser to that provider and never pass through the server, which stores only encrypted refresh tokens and connection metadata. It is built as a pnpm workspace — a Vite + React client, a Hono API on Cloudflare Workers backed by D1, and a framework-free core package holding the provider adapters and the drawing file's rules — and it is designed to be self-hosted end to end on your own Cloudflare account. The project is at its beginning; [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the source of truth for the architecture and the decisions behind it. Licensed under [AGPL-3.0](LICENSE).

It is a sibling of [skysa-notes](https://github.com/skysa-org/skysa-notes), and started as a copy of everything in it that does not care what a file holds: the API, the storage adapters, the naming rules, the PWA and brand build ([`docs/decisions/0002-carried-over-from-skysa-notes.md`](docs/decisions/0002-carried-over-from-skysa-notes.md)).

## Contributing

Bug reports and small focused pull requests are both welcome; see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for how to get it running and what a change
is expected to carry, and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for how
people are expected to treat each other. Contributors sign a
[CLA](CLA-individual.md) once — a license grant, not an assignment: you keep
ownership of your work and every right to use it elsewhere, and in exchange the
project is bound to keep every contribution available under AGPL-3.0.

Security problems go through [private reporting](SECURITY.md), never a public
issue. The project name and logo are not covered by the code license
([`TRADEMARK.md`](TRADEMARK.md)); forks rebrand. The copyright notice is in
[`NOTICE`](NOTICE) — `LICENSE` is a verbatim copy of the AGPL and stays one.

The legal texts are **drafts that have not been reviewed by counsel** and say so
at the top.

## Development

Requires Node 22.13 or later and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm run setup      # asks what it needs and writes apps/api/.dev.vars
pnpm db:migrate     # apply D1 migrations to the local database
pnpm dev            # Vite on :5173, wrangler dev on :8787
```

`pnpm run setup` only asks for the providers you say you want; `.dev.vars.example`
documents every key if you would rather write the file by hand. The `run` is not
optional — `pnpm setup` is pnpm's own built-in command, as is `pnpm deploy`.

`pnpm dev` runs both servers; Vite proxies `/api` to the Worker so the app and the
API share an origin, matching production where one Worker serves both.

Every provider that syncs needs its own app registration (Dropbox, Microsoft
Entra or Google Cloud) and credentials in `apps/api/.dev.vars`; see
`.dev.vars.example`. WebDAV support is deferred indefinitely (`docs/ARCHITECTURE.md`
§5.4).

| Command | What it does |
|---|---|
| `pnpm dev` | Web + API dev servers |
| `pnpm build` | Build core, SPA, then a Worker dry-run bundle |
| `pnpm size` | Check the built SPA against its size budget (after `pnpm build`) |
| `pnpm test` | Vitest across all packages |
| `pnpm coverage` | The same tests as one run with coverage, against the thresholds in `vitest.config.ts` |
| `pnpm lint` / `pnpm lint:fix` | ESLint across all packages, with or without auto-fix |
| `pnpm typecheck` | `tsc --noEmit` across all packages, and core's source again with no Node types |
| `pnpm format` / `pnpm format:check` | Prettier write / check |
| `pnpm knip` | Unused files, exports and dependencies; an export kept on purpose is tagged `@public` with its reason |
| `pnpm verify` | format:check + lint + typecheck + knip + test — run before every commit |
| `pnpm db:generate` | Generate a Drizzle migration from the schema |
| `pnpm db:migrate` / `pnpm db:migrate:remote` | Apply migrations locally / to Cloudflare |
| `pnpm run setup` | Prompt for credentials and write `apps/api/.dev.vars` |
| `pnpm run deploy` | Build core, SPA and Worker, then `wrangler deploy` |

Current status: **the architecture is in place; it does not draw yet.** Drawings and folders live in IndexedDB and work fully offline: make one, name it, delete it, and it is a real SVG file carrying its own id and title, shown as an image. The API that connects a storage account and mints its tokens is carried over whole from skysa-notes and passes its tests against a fresh schema, as are the Dropbox, OneDrive and Google Drive adapters. What comes next, in order, is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §10: the sync engine ported behind a document-format seam, then the editor.

One limit to know before choosing Google Drive: the app asks Drive for access only to the files it creates (the `drive.file` scope), so drawings copied into its folder on the Drive website, with Drive for desktop or by another app stay invisible to it. Dropbox and OneDrive show the app everything in its folder.

There is no sign-in and there will not be one: identity and storage are coupled deliberately, so each connected account is its own silo and nothing on the server knows that two of them belong to one person (`docs/ARCHITECTURE.md` §6). WebDAV is deferred indefinitely (§5.4).

Self-hosting it on your own Cloudflare account is [`docs/self-hosting.md`](docs/self-hosting.md). The architecture and the decisions behind it are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
