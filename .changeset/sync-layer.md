---
'@skysa/draw-web': minor
---

The sync layer (docs/ARCHITECTURE.md §7): the Dexie `SyncStore` over a schema rewritten in place at version 1, held to the kit's store contract; the shared kit's scheduler (`@skysa/client` 1.1.0), which runs the engine for each connected account under this app's lock; the account flow, over the kit's connection, credential, token, relay and API clients; and a source, or what it never sent, downloaded as a zip of `.svg` files.
The connect flow's screens: the sources at the top of the library, the account panel with its devices, sync state and disconnect, and the return from the provider.
`saveDrawing` takes `expected` and answers `changed`, writing nothing, where the row changed from elsewhere since; the editor then keeps its edits as a copy.
A deleted drawing is a tombstone until the push sends its delete.
