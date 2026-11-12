---
'@skysa/draw-api': minor
---

The server is the shared kit's `@skysa/server` 1.0.0 (skysa-notes' record 0018, step 4): `apps/api` keeps the Worker entry, and `@skysa/draw-api` and `@skysa/draw-api/relay` offer the server's names as before.
The D1 migrations are the kit's, which `wrangler.toml` now finds at `node_modules/@skysa/server/migrations`.
A database made by 0.1.0 is reset onto them rather than migrated: `docs/self-hosting.md`, "A database from 0.1.0", gives the two commands.
Every device then connects again; no drawing is in the database.
`AUTH_MODE` and `WEBDAV_ALLOW_PRIVATE` are no longer read: the Worker boots and asks for either to be removed, and `AUTH_MODE=account-first` is still refused.
`pnpm db:generate` is gone with drizzle-kit, since the schema is the kit's.
