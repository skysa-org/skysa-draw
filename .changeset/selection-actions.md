---
'@skysa/draw-web': minor
---

A context menu on the canvas, opened by a right-click, a pen's barrel button, the Menu key or Shift F10, listing what can be done with what is selected (docs/decisions/0004-the-interface.md, "The context menu"); the options strip shows the same actions as a selection bar, for a touch screen.
The area selection can be inverted and feathered, and every raster tool honors both.
Fill… asks for the contents (the fill color, the stroke color, a color of your own, or Content-Aware, which makes the selected pixels again from the picture around them), a blend mode, an opacity and whether to preserve transparency.
Layer via copy and Layer via cut work on an area of a raster layer and on the selected elements of a vector one, each in one command.
The move tool moves the selected pixels of a raster layer, Alt for a copy and the arrows to nudge, and a marquee or lasso drag inside the area moves its outline.
The magic wand (W) selects pixels of a color near the one clicked, joined to it or anywhere, and on a vector layer the elements painted in it.
New keys, as in Photoshop: Select inverse Ctrl or ⌘ Shift I, Feather Shift F6, Layer via copy Ctrl or ⌘ J while something is selected, Layer via cut Ctrl or ⌘ Shift J, Fill… Shift F5 or Shift Backspace, with the fill color Alt or Option Backspace and with the stroke color Ctrl or ⌘ Backspace.
