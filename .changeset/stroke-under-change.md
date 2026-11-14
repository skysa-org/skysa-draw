---
'@skysa/draw-web': patch
---

A stroke still being encoded when the drawing changes elsewhere is kept in a conflict copy beside the change, as any unsaved edit is, rather than lost when the editor reopens on the change.
