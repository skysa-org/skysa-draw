---
'@skysa/draw-web': minor
---

The fill and the stroke are one button in the tool bar that shows both, as Photoshop's foreground and background are: a press opens the color panel and another closes it, and the panel swaps them (X) and puts back the defaults (D).
The color panel lays out each color as Fill… does its groups, the name over the swatch, the hex and None, which no longer wrap, and the recent colors under them; the options strip's colors stay on one row.
The move tool has Auto-select, as in Photoshop: a press makes the topmost layer with something under it the active one and moves it, passing over hidden and locked layers, and Ctrl or ⌘ does the other for that press.
An option that is on or off, Auto-select, Contiguous, Pressure or Constrain, shows its name beside a check box instead of a check mark alone.
Space presses a button the keyboard is on, instead of always holding the hand; held after a tool is clicked, it still pans.
The marquee, the lasso and the magic wand select in Photoshop's four modes, New selection, Add to, Subtract from and Intersect with selection, from the options strip or with Shift, Alt or Option, or both, held as the drag or click begins; subtracting from and intersecting with an inverted selection work too.
Modify… opens one dialog for Photoshop's Expand, Contract, Smooth, Border and Feather, with a radius in px remembered for the session; Feather joins it there, so the menu and the selection bar no longer carry a Feather… of their own, and Shift F6 opens Modify… at Feather. One that would leave nothing selected keeps the selection as it was, and says so.
Transform selection puts a box with handles on the marching ants that moves, scales and rotates the selection's outline, applied with Enter and canceled with Escape, as in Photoshop; Ctrl or ⌘ Z steps back through its drags, and the options strip shows only Apply and Cancel while it lasts.
Fill… and Modify… no longer show a slider's value cut off under the number field beside it.
The tool bar shows only the tools that work on the active layer: no Smudge on a vector layer, no Pen, Node or Text on a raster one, and the move tool and the view's tools on a group; the tool in hand stays, faded, until another is chosen.
A checkered transparency grid is behind the drawing, as in Photoshop, so clear and empty parts show as such; its squares keep one size on screen at every zoom.
A double press with the move tool edits a text in the text tool and a path or a shape in the node tool; a text's size and fill can be changed while it is typed, without closing it, and the options show an edited text's own.
While a text is edited, the old text is hidden under the field instead of showing through it until the field closes.
A double-click on the drawing's title renames it.
The eyedropper's icon no longer looks like the pencil's.
The app's words are in US English: Color, Swap colors, Recent colors, Color dodge, Color burn, Grayscale.
The tool bar keeps Photoshop's groups and order, a light rule between each two, and folds a group into one button only where the bar is too short to show every tool: the button shows the tool last used in the group, with a mark in its corner, and a long press or a right-click opens the group's menu.
The Remove tool (J): paint over something on a raster layer and it is made again from what is around it, by the same content-aware engine as Fill…, in one undoable step.
The Red eye tool (J, with Remove) darkens a pupil a flash turned red, by a click or a box dragged around it, with Pupil size and Darken amount; Remove and Red eye have icons of their own.
The move tool's Auto-select takes the selected shape's handles away when a press picks a raster layer, instead of leaving them around a shape no longer selected.
The options strip spaces each option from the next, and a slider in it no longer squeezes under its neighbor's name where the strip is short: the strip scrolls instead.
A selected shape's handles go away while its layer is hidden and come back when it is shown; the shape stays selected.
The brush, the pencil, the eraser, the smudge and Remove show their size over the canvas as a circle exactly as big as what they paint, as in Photoshop, at any zoom and on vector and raster layers alike, following `[`, `]` and the Size slider; under a few pixels it is a crosshair.
A stroke on a scaled layer now lands at the size it was shown instead of larger or smaller.
Painting on a raster layer that was moved, or that covers only part of the canvas, now lands wherever it is painted on the canvas instead of being cut off at the layer's old edge: the brush, the pencil, the shapes, the paint bucket, Fill…, Remove and the smudge grow the layer to hold what they put down, and the move tool keeps pixels moved past the layer's edge, off the canvas too, in one undoable step; the eraser never grows a layer.
What is painted live on a raster layer shows only on the canvas, as it will once it lands.
The brush's circle matches the paint: a mouse or a finger now paints the whole size, since pressure changes the width only from a pen, as in Photoshop, and a soft brush's circle is drawn where its paint is half opaque, as Photoshop's Normal Brush Tip is.
The brush's circle and the marching ants now show over a stroke being painted on a raster layer instead of under it.
What is being painted, smudged or moved on a raster layer now shows under the layers over it, as it will once it lands, instead of over every layer.
Several layers can be chosen in the layers panel with Ctrl or ⌘ and Shift, as in Photoshop, and grouped, moved up or down, deleted, duplicated and moved on the canvas with the move tool together.
Layers can be dragged to another place in the layers panel, into and out of groups, keeping where they are drawn, and moved a step with Alt and an arrow.
Groups in the layers panel collapse by their folder icon, whose caret turns, and an empty group's folder has none; an unnamed group is called "Group n".
The panel's New menu makes a vector layer, a raster layer or an empty group; Move up and Move down moved from the panel's head into its actions menu, since dragging a row moves a layer.
A right-click on a layer opens the layer actions menu, which now lists only what applies to the layers chosen.
The move tool's options bar aligns and distributes the layers chosen, as Photoshop's does: by their edges or centers, or with even spacing, to the selection or to the canvas.
The move tool's Auto-select can pick the layer or its outermost group, as Photoshop's Layer and Group modes do.
A move with the move tool snaps to the canvas and to the other layers' edges and centers, showing a guide, as Photoshop's smart guides do; Snap turns it off, Ctrl or ⌘ Shift ; toggles it, and Control held during a move suspends it.
The editor's More menu has Photoshop's Image menu: Image size…, Canvas size…, Image rotation (180°, 90° either way, any angle, and flips), Trim… and Reveal all, each one step of undo.
A menu item can now open a submenu beside it, by the arrow keys, Enter, a press or the pointer resting on it.
Export, Fill… and Modify… now share one dialog form with the Image dialogs, so Enter applies from any control but a button or a text field in each, and Export opens with the focus on its format.
A clipped layer keeps its clip where the layer below is when it is dragged, nudged, aligned, carried into or out of a group, ungrouped, or turned, flipped or resized with the canvas, and a clip made on a moved or turned layer no longer shows the layer below moved twice.
What a vector tool draws after Image rotation, a flip, Image size or a Free Transform of its layer is upright, unmirrored and at the sizes the options say, and the move tool, the marquee and the pickers find it by its own box rather than a larger one.
Align and distribute now line up the elements selected on a vector layer with each other, such as a text, a shape and a line, instead of moving their whole layer.
The layers panel shows a preview of each layer, a vector layer's marked in its corner; a vector layer of two or more items expands into a row per item, and a press on one selects it on the canvas.
An item in the layers panel has its own menu, the canvas's, which now arranges and duplicates what is selected on a vector layer; items are dragged within their layer or into another vector layer, and a locked or hidden layer's items are shown but not selected from the panel.
The layers panel's preview of a large raster layer no longer stalls the page after each stroke, or each time the panel is shown: it is drawn from a small copy of the layer's picture, made once.
A vector layer of hundreds or thousands of items expands at once in the layers panel and no longer stalls the page after each change to it: only the rows in view are drawn.
A stroke on a large raster layer no longer stalls the page while it is written: the layer's picture is encoded, and the layers panel's small copy of it made, in a background worker, and the save works out the drawing's hash there too.
With the move tool the arrows nudge the elements selected on a vector layer, or with nothing selected the active layer whole, and an undo of a move, a nudge or an alignment keeps the elements selected; a press on an item in the layers panel, or a drag of one, hands the arrows to the canvas, so they nudge it.
A layer inside a locked or hidden group can no longer be painted on or moved, as the group's lock and visibility now reach every layer in it.
Work that holds the page on a large layer — Image size with Resample, Trim, Reveal all, Place picture…, Merge down, Modify…, and Fill, Clear and Layer via copy or cut on a raster layer — shows an "Applying…" card in its own words once it has gone on 300 ms, and nothing can be pressed until it is done.
The color panel opens beside the colors' button, in a container like a tool group's menu, rather than in a drawer at the far edge of the window or a sheet over the canvas on a phone: beside the rail on a desktop or a tablet, and over the bar on a phone. A press on the canvas that puts it away draws nothing.
