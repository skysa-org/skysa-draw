---
'@skysa/draw-core': minor
---

The storage layer is the shared kit's `@skysa/storage` 1.1.0 (skysa-notes' record 0018, step 4), so `@skysa/draw-core` no longer offers what 0.1.0's did of it: `cell`, the provider adapters and their errors, the paths, the hashes, the media types and the conflict names but this app's own.
A Worker entry of your own that took `cell` from `@skysa/draw-core` takes it from `@skysa/storage`, at the version this repository pins, as `apps/api/src/worker.ts` does.
The protocol is still offered from `@skysa/draw-core`, the types an entitlement or rate-limit policy is written against among it, so a policy written against 0.1.0 builds as it did.
`AUTH_MODES` and `AuthMode` are gone with `AUTH_MODE`.
