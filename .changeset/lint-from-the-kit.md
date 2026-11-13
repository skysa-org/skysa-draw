---
'@skysa/draw-core': minor
---

The lint, the compiler's settings and Prettier's are the shared kit's `@skysa/eslint-config` 1.1.0 (skysa-notes' record 0018, step 4).
Every package's tsconfig extends the kit's settings through the root `tsconfig.base.json`, so a deployment that builds this repository as a git submodule, without installing its root `package.json`, adds `@skysa/eslint-config` at the version this repository pins to its own devDependencies.
