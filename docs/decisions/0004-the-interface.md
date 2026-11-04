# 0004. The interface

*2026-11-04. Cited in the code as §7, "The interface". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**One set of components, placed by the window's size class; the tools users already know, under the names and keys they know them by, each one tool whatever kind of layer it is on.**
The app is used on a phone, on a tablet with a pen and on a desktop with a mouse, and the question was how one editor serves all three without becoming three.

Three ways were weighed.
A phone editor and a desktop editor, each its own components, is twice the work and two apps that drift; a user who draws on a tablet and finishes on a desktop would learn both.
One layout squeezed by media queries, as the notes app's three panes stack on a narrow window, keeps a desktop's panels on a phone where there is no room for them beside a canvas, and a canvas is the one thing that must have the room.
One set of components, with a frame that places them differently in each size class, is one app whose pieces are the same everywhere and whose arrangement is what the screen can hold.
So the components are one set (`apps/web/src/components/ui/`) and a component never asks how wide the window is: the frame (`drawing/Editor.tsx`) reads the size class once and places each piece, and the piece fits its container.

The size classes are Material's window size classes, `compact` under 600 px, `medium` from 600 to 839 and `expanded` from 840 (https://m3.material.io/foundations/layout/applying-layout/window-size-classes): the published rule the most apps follow, which falls where phones, tablets and desktops in fact fall, and which agrees in practice with Apple's compact and regular widths.
On compact the canvas fills the window, the tools are a bar along the bottom under one row of options for the active tool, and the layers and the color open as sheets over the canvas, one at a time, which is how Procreate and every phone editor arrange it.
On medium the tools are a rail down the side, the options a row over the canvas, and the panels a drawer over the canvas from the far side.
On expanded the panels are a dock the canvas sits beside, layers over properties, both open by default from 1200 px, which is where Figma, Illustrator and Affinity put them.
An open drawing fills the window on every size, and the library of folders and drawings is the screen before it on compact and a drawer from the top bar elsewhere, as a gallery is to a canvas.

Every control is at least 44 CSS px in either direction on every size and for every pointer: Apple's minimum, a hair under Material's 48, and the size a finger needs whether or not a mouse is also attached.
Input is Pointer Events only, never touch or mouse events, so one handler sees a finger, a pen and a mouse alike with `pointerType` to tell them apart, `pressure`, `tiltX` and `tiltY` where the device gives them, and `getCoalescedEvents()` so a fast stroke keeps every sample.
A pen draws; a finger draws unless a pen is down, which is palm rejection; two fingers pan and pinch to zoom; a two-finger tap undoes and a three-finger tap redoes, as in Procreate; a wheel scrolls and zooms with Ctrl or ⌘; Space held pans.
Keys work on every size, since a tablet may have a keyboard.

The tools are the ones users of Figma, Illustrator, Photoshop, Procreate and Krita already know, under the keys those agree on, and one tool is one tool: the same name, key and options on a vector layer and on a raster one, doing on each what a user of that tool expects.

| Tool | Key | On a vector layer | On a raster layer |
|---|---|---|---|
| Select | V | Pick, move, resize and rotate elements, as `transform`; a double press edits a text or a path in its tool; with Auto-select on, a press first makes the topmost layer under it the active one | Move the selected pixels, or the layer where none are selected, of the layer Auto-select picks where it is on |
| Node | A | Edit a path's points | — |
| Hand | H, Space | Pan | Pan |
| Zoom | Z | Zoom to a point or a drag | Zoom |
| Pencil | N | A freehand `<path>`, smoothed, of one width | A hard-edged stroke |
| Brush | B | A filled `<path>` whose width follows pressure | A soft stroke with size, opacity, hardness and pressure |
| Eraser | E | Remove the element under the pointer | Erase pixels |
| Smudge | S | — | Push pixels |
| Fill | G | Set the fill of the element under the pointer | Flood fill |
| Eyedropper | I | Read an element's fill or stroke | Read a pixel |
| Rectangle | R | A `<rect>` | A filled rectangle of pixels |
| Ellipse | O | An `<ellipse>` | A filled ellipse of pixels |
| Line | L | A `<line>` | A line of pixels |
| Pen | P | A Bézier `<path>`, point by point | — |
| Text | T | A `<text>` | — |
| Marquee, Lasso | M, Q | Select elements in a region | Select pixels in a region |
| Magic wand | W | Select the elements painted in a color near the one clicked | Select the pixels of a color near the one clicked, joined to it or anywhere |
| Crop | C | The canvas's `viewBox` | The canvas's `viewBox` |

Undo and redo are Ctrl or ⌘ Z and Shift with it; Ctrl or ⌘ A selects all and D drops the selection, Shift with I inverts it, J makes a new layer of what is selected (Layer via copy) and duplicates the layer when nothing is, and Shift with J cuts what is selected to a new layer (Layer via cut), as in Photoshop; the arrows nudge the selected pixels with the select tool, a pixel at a time or ten with Shift; Shift F6 feathers the selection; Shift F5 or Shift Backspace opens Fill…; Alt or Option Backspace fills it at once with the fill color, the one Alt chord the map takes, and Ctrl or ⌘ Backspace with the stroke color; inside a text field all three stay the field's; Shift Delete still deletes; `[` and `]` change a brush's size; X swaps the two colors and D puts back the default ones; Ctrl or ⌘ 0 fits the drawing to the window and 1 shows it at actual size; Delete removes what is selected; Escape cancels what a tool has begun.
A new layer is Insert, Krita's key, with no modifier, since Shift and Ctrl with Insert are paste and copy on Windows and Linux; Photoshop's Ctrl or ⌘ Shift N is kept for an installed window, but a browser tab never receives it, and a Mac keyboard has no Insert, so on a Mac in a tab the layers panel is the way.
The map is one file, `drawing/keys.ts`, so a dispute about a key is settled in one place.
Chrome on Windows and Linux keeps Ctrl Shift I for its developer tools in a tab, so there the context menu and the selection bar are the way to Select inverse, as the layers panel is to a new layer on a Mac.

**The two colors.**
The fill and the stroke are at the foot of the tool bar, after the tools, as Photoshop shows its foreground and background: the fill's square in front at the top left, the stroke's behind it at the bottom right, none struck through.
On a raster layer the brush paints with the fill and the pencil with the stroke, so they are the foreground and the background by other names.
Photoshop's swap and reset are glyphs a mouse can hit at 12 px and a finger cannot, so here the pair runs along the bar a 44 px target per control, the fill, the stroke and the swap, 132 px down the rail on medium and expanded.
The reset is not in the bar on any window: it is pressed seldom, and D does it, so it is in the color panel beside the panel's own swap, each with its key in its tooltip.
A compact window's bottom bar is short of room, so there the pair is two targets, both colors in one control that opens the color sheet on the fill, and the swap.
The pointer over a color rings its square in the hover color rather than lighting its target, since the squares are drawn across their targets and a lit target would sit beside the square it stands for.
A press on a color opens the color panel on that color, marked and with the focus in its field, and a second press closes it, as a toggle does.
X swaps the colors and D puts back the defaults, as in Photoshop; Ctrl or ⌘ D stays deselect.
The pair is where the tool's options are set (`tools/optionsRegion.ts`), so a color pressed, swapped or reset while the text tool's field is open is the text's.
Rejected: Photoshop's pair as a 2×2 of 44 px corners, which needs 88 px across where the rail and the bottom bar have 52; one color button with a badge, which showed the fill and hid the stroke; and the reset as a fourth target in the bar, which took 44 px of the rail for good for a press D does.

**A double press.**
A double press with the select tool edits what it is on in the tool that edits it, as a double-click does in Illustrator, Figma and Inkscape: a text in the text tool, its caret at the press, and a path or a shape in the node tool, its anchors shown.
A shape goes to the node tool too, since the node tool is the one editor of a shape's geometry here and makes it a path only on its first edit.
A group inside a layer is gone into, to the path or the shape under the press; the select tool does nothing on a group layer, and says so, so neither does a double press there.
The canvas hears Pointer Events alone, so the select tool tells a double press itself: two presses within 500 ms, the platform's double-click time, on the same element, by the same kind of pointer, within 4 CSS px for a mouse or a pen and 22 for a finger, the first of which did not drag.
The second press starts no drag, and the other tool is put in hand as the pointer lifts, through the frame, so the tool bar shows it and a pinch that cancels the second tap changes nothing.
While the text tool's field is open, the focus may go to the options strip, the color panel or the color button and come back without finishing it, and a size or a color chosen there is the text's at once, the whole text's, since a `<text>` here has one size.
The field opens with the text's own size and fill in the options, so the strip shows what the text is, and has the focus back, with its selection, when a slider is let go, a color is picked, a button is pressed, or Enter is pressed in a control; a control worked by keys keeps the focus until Enter, or until Tab takes it on.
A size for some of a text's characters would need runs, a `<tspan font-size>` each, and a field that shows mixed sizes, which a textarea cannot, and it is not built.
A double-click on the drawing's title in the top bar renames it, as More's Rename does.

**Auto-select.**
The move tool's one option is Auto-select, Photoshop's Auto-Select in its Layer mode, off by default as there.
With it on, a press makes the topmost layer with something under it the active one, and the same press moves it: on a vector layer the element under it is selected and dragged, on a raster layer the layer moves whole, or the area's pixels where the area reaches that layer.
Ctrl or ⌘ held as the press begins does the other for that press, as in Photoshop.
Something is under the press where the layer is more than half opaque there as seen, Photoshop's line: a vector layer where the select tool's own hit finds an element, a raster layer by its pixel's alpha, either times its opacity and its groups', and a layer clipped to the one below only where that one has paint.
Hidden layers and the layers of hidden groups are passed over, and a group is gone into, never picked.
A locked layer is picked and says it is locked, as Photoshop picks one and refuses the move.
A press over nothing, or on a handle of the box around what is selected, keeps the active layer.
A press that is canceled, by Escape, a second finger or a long press that opens the menu, gives the active layer back.
Group mode, which picks the outermost group, waits for the move tool to move a group.
Rejected: keeping the active layer for a press inside an area, which Photoshop 20 and 21 did in a bug Adobe acknowledged; a notice when a press picks a layer, which the layers panel shows already.

**The context menu.**
A right-click on the canvas opens a menu of what can be done with what is selected; so do a pen's barrel button, the Menu key or Shift F10 while the canvas has the focus, and a long press where the browser turns one into a `contextmenu` (Chrome on Android).
iOS Safari sends none, and the selection bar is the way there; the app does not make up a long press of its own.
Shift F10 is the canvas's own key, opened on the keydown, since a Mac's browsers make no `contextmenu` of it though WAI-ARIA names it the key for a context menu everywhere; the key is spent, so a Windows or Linux browser makes no second menu event.
The browser's own menu is kept from the canvas, and only from the canvas.
It never opens during a stroke, except for a finger the browser took for a long press, which was never a stroke and is canceled.
A right-click, a barrel button and, on a Mac, a Control-click start no stroke, and the press that closes the menu draws nothing.
A keyboard's `contextmenu` is told from a pointer's by its `pointerType`, which is empty for the keyboard (Pointer Events 3), or, where the browser still sends a plain `MouseEvent`, by the Menu key or Shift F10 having come just before.
A menu the keyboard opens sits at the middle of what is selected, or of the canvas when nothing is, kept inside the canvas.
What it lists depends on what is selected.
With an area selected: Deselect, Select inverse, Feather…; Layer via copy, Layer via cut; Fill…, Clear; Crop to selection.
With elements selected on a vector layer: Deselect, Select inverse; Layer via copy, Layer via cut; Delete.
With nothing selected: Select all; Undo, Redo; New layer, Duplicate layer.
An action that cannot be done is shown disabled, never hidden: the pixels' actions on a vector, locked or hidden layer (a copy only reads, so a locked raster layer allows it), and Crop to selection on an inverted area.
The list is made in one place, `drawing/selectionActions.ts`, and the options strip shows the same list as a selection bar after the tool's own options, while the marquee, the lasso or select is the tool and something is selected, so a touch screen has every action a right-click has.
After Layer via copy or Layer via cut, the selection is dropped and the new layer is the active one.
The menu is a button's menu without the button (`components/ui/MenuList.tsx` is the list both show, its keys and its rules between groups), opened in the top layer under the point, or left of it and above it where the window has not the room, never past an edge, and as tall as fits with the rest scrolling.
Escape, Tab, a choice, a press, a scroll or a wheel outside it, a resize or the window losing the focus close it, and the focus goes back where it was; a choice closes it before the item acts, so a dialog the item opens has the focus.
Fill… is a dialog of the frame's, a sheet on compact and a drawer elsewhere, as Feather… is.
It asks the contents first, the fill color, the stroke color, Color… with a color field of its own, or Content-Aware, each with its swatch, then the blending: a mode from the layers' own list, an opacity and Preserve transparency.
The focus starts on the contents chosen, Enter applies from any control but a button or a text field, and Escape or Cancel leaves the layer as it was.
It opens at what was last applied, for the page's life, as Photoshop's does; a Cancel changes nothing.
Rejected: a Fill submenu of the context menu, which cannot hold a mode and an opacity, and a fill option on the fill tool, which floods by tolerance and is not the area's.
A tool that does nothing on the active layer's kind says so and is not available, rather than doing something else.

Rejected: a component library, which brings tokens of its own to reconcile with the brand's and more than this app uses, when the set here is small and in the house style already; an icon font or icon package, when thirty line icons at 24 px are drawn by hand in `icons.tsx` and cost nothing to load; touch and mouse events beside pointer events, which is the same stroke handled twice; a "simplified" phone editor with fewer tools, since the tools are the product and the screen only decides where they sit.
