# 0003. Layers

*2026-11-04. Cited in the code as §3, "Layers". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**A layer is a direct child of the root that draws something, each one vector or raster; what SVG can say about a layer is said SVG's way, and only what it cannot is the app's.**
The product is a drawing and image editor with full layering, each layer vector or raster, and the question was how layers live in a file that is SVG (`0001-the-drawing-file.md`) and stays one.

Three shapes were weighed.
A table of layers in the app's own namespace, `<draw:layers>` in `<metadata>` pointing at groups by id, would hold any fact about a layer, and would be a second structure that can disagree with the first: a group deleted by another tool leaves a row that names nothing, and a group added by one is a layer to no one.
A nested `<svg>` per layer gives each its own coordinate system, which nothing here needs, and no other tool treats a nested `<svg>` as a layer.
The direct children of the root are what Inkscape (`<g inkscape:groupmode="layer">`) and Illustrator (`<g id="Layer_1">`) already use as layers, so a file from either has layers in this app without conversion, and a file from this app has layers in those tools as groups, which is the most they can be told.
So a layer is a direct child of the root that draws: a `<g>`, or a graphics element on its own.
`<defs>`, `<title>`, `<desc>`, `<metadata>`, `<style>` and the elements that only define things are not layers.
Document order is paint order, bottom to top, as SVG paints; the panel shows the top first, as every layers panel does.

A layer has a kind, `draw:kind`, written on the layers this app makes.
A `vector` layer is a `<g>` of SVG's own graphics elements, as any tool writes them.
A `raster` layer is a `<g>` holding one `<image>`, rather than the `<image>` alone, so the layer carries its transform, opacity, blend mode, mask and filter like any other, and so an empty raster layer exists before its first stroke.
The image's `width` and `height` are in user units and its pixels are its own: one per user unit, up to `RASTER_MAX_SIDE` on the longer side, past which a large canvas has fewer pixels than units rather than a bitmap no phone can hold.
Past the image's box the layer is transparent: an edit that lands there grows the box, in the layer's own pixels and units, rather than being cut to it, so a raster layer moved by its `transform` takes paint wherever the canvas is; its `transform` is never touched by a pixel edit.
A pixel edit re-encodes the image whole as PNG, which is lossless; a picture placed from a file keeps its bytes and its type until a pixel of it changes, so a photo is not re-encoded by being looked at.
The bytes are a `data:` URL for now; when attachments beside the drawing arrive (§10), a threshold decides which go beside (`INLINE_RASTER_BYTES`), as `0001` planned.
A `group` is a `<g>` of layers, each by these rules, for the folders every layers panel has.

What SVG can say about a layer is said SVG's way, where every renderer and every other tool reads it: hidden is `display="none"`, opacity is `opacity`, the blend mode is `mix-blend-mode` in `style` because it has no presentation attribute, a mask, a clip and an adjustment are `mask`, `clip-path` and `filter` referring into the root's `<defs>`, and position is `transform`.
What SVG cannot say is the app's, in its namespace: `draw:name`, the name the user typed, and `draw:locked`.
A layer's `id` is `layer-<n>`, the smallest `n` free in the document.
The history, the masks and the clips refer to a layer by it; an unnamed layer is shown as "Layer n" and an unnamed group as "Group n" by its number, so each keeps its number when it is moved, as it does in Photoshop, and so no English is written into the file.

A file from elsewhere has layers by the same rules without a byte written to it.
A `<g>` with no `draw:kind` is vector, unless its only graphics child is one `<image>`, which makes it raster; a graphics element loose at the root is a vector layer of one element, wrapped in a `<g>` the first time it is edited; a layer with no `id` is given one the first time the file is written, which an edit does anyway; `inkscape:label` is read as a name where `draw:name` is absent, and never written.
A `<g>` is a group only where it says so: Illustrator nests groups for shapes, and every nested `<g>` as a folder would be a panel nobody could use.

*Amended 2026-11-04, when the layer operations were built.*
An adjustment stack is one `<filter id="adjust-<layer id>" color-interpolation-filters="sRGB">` per layer in `<defs>`, its region widened to half the box on each side so a blur or a shadow is not cut at the edge, and the layer says `filter="url(#adjust-<layer id>)"`.
It holds one primitive per adjustment, in the stack's order, and each says what it is in the app's namespace, `draw:adjust="<kind>"` with one `draw:<parameter>` per value, since a primitive's own attributes cannot say which slider made them: brightness and contrast are `feComponentTransfer` lines, hue and saturation are `feColorMatrix`, blur is `feGaussianBlur`, invert is a transfer table, grayscale is a desaturation, and a shadow is `feDropShadow`.
The SVG attributes are written from the `draw:` values and never read back; a filter that is not of this shape is another tool's, shown as one, and never written to.
A filter that two layers share, as a duplicated layer does, is forked on the first edit.
A clip to the layer below, Photoshop's clipping mask, is `<mask id="clip-<layer id>" style="mask-type: alpha">` holding `<use href="#<the layer below>"/>`, and `mask="url(#clip-<layer id>)"` on the layer; a layer whose mask is another tool's is not clipped.
The clip names the layer below by its id, so reordering the layers does not move it to another.
A mask is drawn in the user space of the layer it masks, so the `<use>` carries the inverse of the clipped layer's own `transform` (`translate(…)` for a move, `matrix(…)` otherwise, none for none), and the layer below is drawn inside the mask where it is drawn on the canvas, as Photoshop's clipped layer slides over a base that stays.
Every command that changes a clipped layer's own `transform` keeps it so in the same step (`keepingClips` in `document/clip.ts`), a drag shows it live, and a duplicate that shares its original's mask gets one of its own, `clip-<its id>`, the first time their transforms would differ.
A file whose `<use>` does not carry it is left as it is until that `transform` changes.
Group wraps one layer in a new `<g draw:kind="group">` at its place, and ungroup puts a group's layers back with the group's `transform` in front of each one's own; a group with an opacity, a blend mode, a mask or a filter is not ungrouped, since its layers would look different without it.
Group of several chosen layers makes the group where the topmost of them is and moves the rest into it; a layer moved into or out of a group, by that or by a drag in the panel, takes the difference between its old groups' transforms and its new ones' in its own `transform`, so it is drawn where it was.
Merge down of two vector layers stays vector, each layer's look kept on a `<g>` of its own inside the lower one; a merge that involves pixels, and rasterize, render the layers to one raster layer, which keeps the id, name and lock of the lower layer, or of the layer rasterized.

Rejected: a UUID for a layer's id, which has no number to show and no reason to be unique beyond the file; the layer's `<title>` as its name, which a browser shows as a tooltip over the picture and which is the drawing's own name when it is the first child of the root; writing Inkscape's attributes beside the app's, two vocabularies that would have to agree, so they are read and not written; adjustment layers that act on every layer below, which SVG cannot say and a filter on a group says in SVG's own words.
