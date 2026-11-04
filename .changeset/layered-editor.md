---
'@skysa/draw-core': minor
'@skysa/draw-web': minor
---

The layer model and the editor's first increment (docs/decisions/0003-layers.md, 0004-the-interface.md).
Core: `emptyDrawing` writes one empty vector layer, `readDrawingProlog`, the layer vocabulary (`LAYER_KINDS`, `LAYER_ATTRIBUTES`, `BLEND_MODES`, `RASTER_MAX_SIDE`, `layerId`, `layerNumber`, `isGraphicsElement`), and `conflictStamp` for a conflict copy's title.
Web: the shared component set placed by window size class, the editor's document model (DOMPurify in place, commands with inverses, a byte-capped history), vector and raster layers, and the first tools: select, hand, zoom, pencil, brush, eraser, fill, eyedropper, rectangle, ellipse, line.
The drawing is mounted in a shadow root, so its own `<style>` stays inside it; a drawing changed elsewhere under unsaved edits keeps the change, and the edits are saved beside it as a conflict copy; a link to a drawing that is not on the device says so.
A drawing deleted elsewhere under unsaved edits keeps them as a new drawing in its place, with a new id, and the editor moves to it; the user's own delete from More takes the unsaved edits with it.
