The default brand: what the app is called and how it looks when nothing else
is given (`docs/ARCHITECTURE.md` §8, "Brand"). A deployment that wants its own
points `DRAW_BRAND` at a `brand.json` of its own when it builds, and changes
nothing here (`docs/self-hosting.md`, "Your own brand").

- `brand.json`: the name ("Draw"), the colours, and where the icons are. No
  fonts, so the app keeps the system's. `brand.schema.json` is its JSON Schema,
  for an editor; `tests/brand.test.ts` holds it to the schema in `brand.ts`
  (`brandJsonSchema`).
- `icons/`: the six icons, at the names and sizes in `BRAND_ICONS`: a pen
  stroke in white on the default brand's gray (`#4B5563`, its light `brand`).
  The favicons are a rounded tile; every other icon is a full square, since
  the platforms that show them round or crop it themselves (the maskable one
  keeps the stroke inside the central 80% circle).
- `icons.mjs`: how they were made, and how to make a set on another colour.
  Its header has the command. `recolour.mjs` recolours a set drawn by hand
  instead, such as one a deployment brings.

See `TRADEMARK.md` on names and marks.
