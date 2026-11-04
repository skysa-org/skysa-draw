---
'@skysa/draw-web': minor
---

The rest of the editor's tools (docs/decisions/0004-the-interface.md): the pen and the node tool, which edit any path and turn a shape into one; text typed in place; the marquee and the lasso, whose area every raster tool paints inside and Delete clears; smudge; and crop, which sets the canvas's `viewBox`.
The layer operations: group and ungroup, clip to the layer below, merge down, rasterize, and a stack of adjustments on each layer, all in SVG's own terms (docs/decisions/0003-layers.md).
Export to PNG, JPEG, WebP and SVG, and a picture placed from a file, a paste or a drop as a new raster layer.
