# 0001. The drawing file

*2026-11-03. Cited in the code as §3, "The drawing file". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**A drawing is one SVG file, and the app's own metadata rides inside it in a namespace of its own.**
The question was what a drawing is on the provider, where the user and every other tool will meet it: the format decides what the app can hold, what sync has to move, and what a file from elsewhere means to it.

Three shapes were weighed.
A JSON document of the app's own would hold anything the editor wants and nothing else could open it; the notes app's whole case for plain files is that another tool can, and a format nobody else reads is a lock-in with extra steps.
A folder per drawing, a manifest beside layers kept as separate images, would let a raster layer be a plain PNG, but a drawing would then be many files the engine has to move together, a conflict would land on one of them, and a file manager would show a folder where the user expects a picture.
An SVG file is one file, every browser renders it, every vector tool opens it, and it has room for the app's own data without hiding it: XML namespaces exist for exactly this.

So a drawing is `name.svg`, as a note was `name.md`, and the folder tree is the same tree (§3).
The root `<svg>` carries `xmlns:draw="https://skysa.org/draw/1"` and `draw:id`, a UUID the app gives a drawing once and never changes, so a rename on one device is the same drawing to another, as the frontmatter `id` was in skysa-notes.
The title is the SVG's own `<title>` child of the root, which other tools show; the filename is its slug, kept unique in the folder (`drawingFilename`, `uniqueFilename`).
The size of the canvas is `viewBox`, with `width` and `height` beside it in user units; a file that says neither is shown at a size of the app's choosing.
The namespace's version is in its URL, so a later shape of the metadata is a new namespace and an old build can tell it does not know it.

Raster content, which image editing needs, goes in as `<image>` elements: small ones inline as `data:` URLs, large ones as files beside the drawing referenced by relative `href`, named by their content as attachments were in skysa-notes (`attachmentName`).
Filters, masks and clip paths are SVG's own, so a non-destructive adjustment is an element in the file and a flattened export is a render of it.
The limit accepted with this is that pixel editing happens on the raster element's bytes, which the editor rewrites whole; a brush stroke on a photo is a new `data:` URL or a new file, not a diff.

A file from elsewhere is read by the same rules.
`isDrawingText` asks only that the root be an `svg` element in the SVG namespace, so anything Inkscape or Illustrator saved is a drawing; one with no `draw:id` is given one on the way in (`withDrawingId`), which rewrites the root tag and nothing else, so every other byte of the file is kept.
What the editor cannot take — an element it does not know — is kept in the file and shown through the browser's own renderer, never dropped.

Core reads all of this without a DOM.
`packages/core/src/drawing/document.ts` scans the prolog and the root tag with a hand-rolled matcher, and the first `<title>` after them, so it runs in Workers and Node as every core module must (CLAUDE.md), and reads only the start of a file however large the drawing is.
Nothing in core parses the body: the body is the editor's, in the browser, through a sanitizer (§9).
