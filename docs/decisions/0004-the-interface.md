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
Space presses a control the keyboard is on, as a browser's button takes it, and pans everywhere else, the tool just clicked included, which keeps the focus in Chrome; `:focus-visible` cannot tell the two apart, since Chrome turns it on at the first key, so the viewport remembers what the last pointer press was in (`viewport/pointerPressed.ts`).
Keys work on every size, since a tablet may have a keyboard.

The tools are the ones users of Figma, Illustrator, Photoshop, Procreate and Krita already know, under the keys those agree on, and one tool is one tool: the same name, key and options on a vector layer and on a raster one, doing on each what a user of that tool expects.
An option that is on or off, Auto-select, Contiguous, Pressure or Constrain, is a check box with its name beside it, as Photoshop's options bar shows them, since no icon says what such an option does; rejected: a check mark alone with the name in a tooltip, which a finger never sees.

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
| Remove | J | — | Paint over what goes; it is made again from what is around it |
| Red eye | J | — | Darken a pupil a flash turned red, clicked or boxed, by Pupil size and Darken amount |
| Fill | G | Set the fill of the element under the pointer | Flood fill |
| Eyedropper | I | Read an element's fill or stroke | Read a pixel |
| Rectangle | R | A `<rect>` | A filled rectangle of pixels |
| Ellipse | O | An `<ellipse>` | A filled ellipse of pixels |
| Line | L | A `<line>` | A line of pixels |
| Pen | P | A Bézier `<path>`, point by point | — |
| Text | T | A `<text>` | — |
| Marquee, Lasso | M, Q | Select elements in a region, in the four selection modes | Select pixels in a region, in the four selection modes |
| Magic wand | W | Select the elements painted in a color near the one clicked, in the four selection modes | Select the pixels of a color near the one clicked, joined to it or anywhere, in the four selection modes |
| Crop | C | The canvas's `viewBox` | The canvas's `viewBox` |

Undo and redo are Ctrl or ⌘ Z and Shift with it; Ctrl or ⌘ A selects all and D drops the selection, Shift with I inverts it, J makes a new layer of what is selected (Layer via copy) and duplicates the layer when nothing is, and Shift with J cuts what is selected to a new layer (Layer via cut), as in Photoshop; the arrows nudge the selected pixels with the select tool, a pixel at a time or ten with Shift; Shift F6 opens Modify… at Feather, as Photoshop's Shift F6 opens Feather; Shift F5 or Shift Backspace opens Fill…; Alt or Option Backspace fills it at once with the fill color, the one Alt chord the map takes, and Ctrl or ⌘ Backspace with the stroke color; inside a text field all three stay the field's; Shift Delete still deletes; `[` and `]` change a brush's size; Ctrl or ⌘ Shift `;` turns snapping on or off, as Photoshop's View › Snap; X swaps the two colors and D puts back the default ones; Ctrl or ⌘ 0 fits the drawing to the window and 1 shows it at actual size; Delete removes what is selected; Escape cancels what a tool has begun.
A new layer is Insert, Krita's key, with no modifier, since Shift and Ctrl with Insert are paste and copy on Windows and Linux; Photoshop's Ctrl or ⌘ Shift N is kept for an installed window, but a browser tab never receives it, and a Mac keyboard has no Insert, so on a Mac in a tab the layers panel is the way.
The map is one file, `drawing/keys.ts`, so a dispute about a key is settled in one place.
Chrome on Windows and Linux keeps Ctrl Shift I for its developer tools in a tab, so there the context menu and the selection bar are the way to Select inverse, as the layers panel is to a new layer on a Mac.

**Selection modes.**
The marquee, the lasso and the magic wand have Photoshop's four modes as their first option, four icon buttons in a group named Selection mode: New selection, Add to selection, Subtract from selection and Intersect with selection, the one in force pressed.
Shift held as a drag or a click begins adds, Alt or Option subtracts and both intersect, for that one, whatever the option says, as in Photoshop; each button's tooltip names its keys.
A key that chose the mode as the drag began does nothing else in it, so Alt held from the start subtracts and does not draw from the center; pressed only after the drag began, Shift keeps the marquee square and Alt draws it from its center.
On a raster layer the new outline meets the area as the mode says, an inverted area read as the canvas outside its outline, so each mode is right for an inverse too, and what is left keeps the feather there.
On a vector layer the elements found meet the elements selected the same way.
A click makes nothing: in a new selection it drops what is selected, and in the other modes it leaves it as it is.
A drag that begins inside the area moves its outline only in a new selection with neither key held; in another mode it makes an outline there, as in Photoshop.
The buttons are pressed or not in a group, as the tool bar's tools are, not radios: a radio group promises that the arrows move the choice, and in the options strip the arrows are the bar's, moving the focus along all its buttons (`components/ui/ChoiceButtons.tsx`).
Rejected: a select of the four, which hides three behind a press where Photoshop's options bar shows them all.

**Transform selection.**
Transform selection puts a box with handles on the marching ants, as Photoshop's Select > Transform Selection does, and moves, scales and rotates the area's outline, not its pixels.
The box is the select tool's, around the outline as it is now, with its eight handles and the rotate handle above, dragged as the select tool's is: inside it moves, a handle scales about the side or corner across, and outside it, or the rotate handle, rotates about its middle.
Shift keeps the ratio and snaps a rotation to 15°, as with the select tool; Alt scales about the middle, as the marquee draws from its middle with Alt; Shift holds a move across, down or at 45°, as a drag of the outline with the marquee does.
Each handle takes a press 44 px across on the screen, the nearest winning, and the middle half of the box always moves, so a box too small for its handles can still be moved.
The marching ants follow every sample and the feather is kept; an inverted area has no outline of its own to put a box on, and is not transformed.
While the box is up the tool in hand does nothing on the canvas and Auto-select picks no layer; Space still pans, and two fingers still pan and pinch, the second putting back the drag the first began.
Enter, or Apply in the selection bar or the menu, keeps the outline, and Escape or Cancel puts it back; while the box is up the menu and the options strip show only those two, the tool's own options hidden, as Photoshop's options bar shows the transform's, and the strip shows them whatever tool is in hand.
Enter aimed at a field, or at a control the keyboard is on, is that control's, as Space is.
The arrows nudge the outline a unit, or ten with Shift.
Ctrl or ⌘ Z, and the top bar's Undo, step back through the drags and nudges, and the redo forward again, as Photoshop does during a transform; while the box is up neither reaches the drawing's history, nor does a two-finger tap.
A new tool, another layer made active, or any other of the selection's actions, Deselect included, applies it first, where Photoshop asks: a question at every change of tool is one more dialog on a touch screen, and Apply is nearly always its answer.
An area is never a step of the history, so neither is a transform of it.
Not built: a box that turns with the outline, as Photoshop's does; the select tool's box stays square to the screen, and two boxes that drag differently would be two gestures to learn.

**The two colors.**
The fill and the stroke are at the foot of the tool bar, after the tools, as Photoshop shows its foreground and background: the fill's square in front at the top left, the stroke's behind it at the bottom right, none struck through.
On a raster layer the brush paints with the fill and the pencil with the stroke, so they are the foreground and the background by other names.
The pair is one tool button, a 44 px target whose face is both squares, the same on the rail and on a compact window's bottom bar; a press opens the color panel and a second press closes it, as a toggle does.
Its name is the pair's, and what each color is, none included, is said after it.
Photoshop's swap and reset are glyphs a mouse can hit at 12 px and a finger cannot, so neither is in the bar on any window: both are in the color panel's header, each with its key in its tooltip, and X and D do them.
The panel shows each color as Fill… shows its groups, the name over a row of the swatch, the hex and None, which never breaks, and the colors used lately under it.
X swaps the colors and D puts back the defaults, as in Photoshop; Ctrl or ⌘ D stays deselect.
The pair is where the tool's options are set (`tools/optionsRegion.ts`), so a color picked, swapped or reset while the text tool's field is open is the text's.
Rejected: Photoshop's pair as a 2×2 of 44 px corners, which needs 88 px across where the rail and the bottom bar have 52; one color button with a badge, which showed the fill and hid the stroke; the fill, the stroke and the swap as three targets along the bar, which took 132 px of the rail and put a second swap beside the panel's; and the reset as a target in the bar, which took 44 px of the rail for good for a press D does.

**A double press.**
A double press with the select tool edits what it is on in the tool that edits it, as a double-click does in Illustrator, Figma and Inkscape: a text in the text tool, its caret at the press, and a path or a shape in the node tool, its anchors shown.
A shape goes to the node tool too, since the node tool is the one editor of a shape's geometry here and makes it a path only on its first edit.
A group inside a layer is gone into, to the path or the shape under the press; on a group layer the select tool moves the group whole, and a double press there does nothing more.
The canvas hears Pointer Events alone, so the select tool tells a double press itself: two presses within 500 ms, the platform's double-click time, on the same element, by the same kind of pointer, within 4 CSS px for a mouse or a pen and 22 for a finger, the first of which did not drag.
The second press starts no drag, and the other tool is put in hand as the pointer lifts, through the frame, so the tool bar shows it and a pinch that cancels the second tap changes nothing.
While the text tool's field is open, the focus may go to the options strip, the color panel or the color button and come back without finishing it, and a size or a color chosen there is the text's at once, the whole text's, since a `<text>` here has one size.
The field opens with the text's own size and fill in the options, so the strip shows what the text is, and has the focus back, with its selection, when a slider is let go, a color is picked, a button is pressed, or Enter is pressed in a control; a control worked by keys keeps the focus until Enter, or until Tab takes it on.
A size for some of a text's characters would need runs, a `<tspan font-size>` each, and a field that shows mixed sizes, which a textarea cannot, and it is not built.
A double-click on the drawing's title in the top bar renames it, as More's Rename does.

**Auto-select.**
The move tool's options are Auto-select, Photoshop's Auto-Select, off by default as there, with its Layer or Group menu beside it; Snap ("Snapping"); and its alignment ("Align and distribute").
With it on, in Layer mode, a press makes the topmost layer with something under it the active one, and the same press moves it: on a vector layer the element under it is selected and dragged, on a raster layer the layer moves whole, or the area's pixels where the area reaches that layer.
Ctrl or ⌘ held as the press begins does the other for that press, as in Photoshop.
Something is under the press where the layer is more than half opaque there as seen, Photoshop's line: a vector layer where the select tool's own hit finds an element, a raster layer by its pixel's alpha, either times its opacity and its groups', and a layer clipped to the one below only where that one has paint.
Hidden layers and the layers of hidden groups are passed over, and a group is gone into, never picked.
A locked layer and the layers of a locked group are passed over too, as a click goes through a locked object in Illustrator and Figma, so the press moves what lies under it.
A press over nothing, or on a handle of the box around what is selected, keeps the active layer.
A press that is canceled, by Escape, a second finger or a long press that opens the menu, gives the active layer back.
Beside it, as in Photoshop, a menu says what Auto-select picks: the Layer, as above, or the Group, the outermost group the layer found is in, which the same press then moves whole; a layer in no group is picked itself either way, and Ctrl or ⌘ picks in the mode chosen.
Where the outermost group holds a locked layer, and so could not move, Group mode picks the outermost group inside it, toward the layer found, that holds none, or the layer itself, for the reason locked layers are passed over: a group that refuses every move would take every press on the layers in it.
With several layers chosen, a press on one of them, or on a layer inside one, keeps the choice and moves them all, in either mode.
In Group mode a double press on a text or a path inside a group is the group's, as Photoshop's is, and opens nothing; Layer mode, or the layer chosen in the panel, opens it.
Rejected: picking a locked layer and refusing the move, as Photoshop does, under which a locked layer takes every press meant for what lies on it or under it; keeping the active layer for a press inside an area, which Photoshop 20 and 21 did in a bug Adobe acknowledged; a notice when a press picks a layer, which the layers panel shows already.

**Align and distribute.**
The move tool's options bar has Photoshop's six alignments after Auto-select, as buttons in its order: left edges, horizontal centers, right edges, top edges, vertical centers, bottom edges (`tools/common/align.ts`).
A menu after them holds the distributions, by top edges, vertical centers, bottom edges, left edges, horizontal centers or right edges, or by even vertical or horizontal spacing, and Photoshop's Align To, the selection or the canvas.
The layers arranged are the ones a drag of the move tool moves: the outermost of those chosen in the panel where there are several, else the active layer alone; one that may not move refuses the whole, in the drag's words.
Each layer is measured by what it paints, as Photoshop measures its pixels that are not clear: a vector layer's shapes with their strokes, a raster layer's pixels that are not clear, a group's layers together (`viewport/layerExtent.ts`); one that paints nothing is left where it is.
Aligned to the selection, the layers line up with the area where one is selected, the canvas where it is inverted, else with the box around them all, else, one layer alone, with the canvas, as Photoshop's has since 2019; aligned to the canvas, with the canvas.
A distribution aligned to the selection keeps the first and the last where they are and so takes three layers; aligned to the canvas it puts them flush with the canvas's sides and takes two.
The six buttons are always there with the move tool and disabled only with no layer; the menu lists only the distributions that apply, as the layer actions menu does.
Each arrangement is one command, each layer moved by its own `transform` as a drag moves it, and one undo puts them back.
With elements selected on a vector layer, and that layer the only one the move tool would move, the arrangement is theirs instead, as Photoshop's path selection tool aligns the paths it has selected and Illustrator its objects (`tools/vector/alignElements.ts`, chosen by `tools/common/arrange.ts`): each is measured by its box as seen on the canvas, moved by its own `transform`, and still selected after, all in one command, and the menu counts the elements rather than the layer.
Until 2026-11-06 the alignment was the layers' alone, and a text, a shape and a line selected on one layer moved together with their layer rather than lining up with each other.

**Snapping.**
A move with the move tool snaps what it moves to the canvas's edges and center and to the other layers' edges and centers, each axis on its own, within a few screen pixels, and a magenta guide shows each snap while it holds, as Photoshop's smart guides do (`tools/common/snap.ts`).
It is on by default, as Photoshop's View › Snap is; the move tool's Snap toggle and Ctrl or ⌘ Shift `;` turn it off and on, and Control held during a move suspends it for as long as it is held, as in Photoshop.
What snaps is the box of what moves: the layers moved whole, by the move tool's drag of several layers, a group or a raster layer, or the elements dragged on a vector layer, which snap to the layer's other elements too.
The layers are measured as alignment measures them (`viewport/layerExtent.ts`), when the move begins; nothing snaps until the pointer has gone 3 screen pixels from the press, so a click selects without moving; the arrows' nudge does not snap, as Photoshop's does not.
An area's pixels, which move in whole pixels of the layer and often along 45° with Shift, do not snap, nor do the resize and rotate handles, for now.

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
With an area selected: Deselect, Select inverse, Modify…, Transform selection; Layer via copy, Layer via cut; Fill…, Clear; Crop to selection.
With elements selected on a vector layer: Deselect, Select inverse; Arrange, a submenu of Bring to front, Bring forward, Send backward and Send to back, as Illustrator's Object › Arrange, and Duplicate, a copy of each just above it, the copies selected; Layer via copy, Layer via cut; Delete.
Arrange and Duplicate have no key: Illustrator's Ctrl or ⌘ [ and ] are a Mac browser's Back and Forward.
With nothing selected: Select all; Undo, Redo; New layer, Duplicate layer.
An action that cannot be done is shown disabled, never hidden: the pixels' actions on a vector, locked or hidden layer (a copy only reads, so a locked raster layer allows it), and Crop to selection on an inverted area.
The list is made in one place, `drawing/selectionActions.ts`, and the options strip shows the same list as a selection bar after the tool's own options, while the marquee, the lasso or select is the tool and something is selected, so a touch screen has every action a right-click has.
After Layer via copy or Layer via cut, the selection is dropped and the new layer is the active one.
The menu is a button's menu without the button (`components/ui/MenuList.tsx` is the list both show, its keys and its rules between groups), opened in the top layer under the point, or left of it and above it where the window has not the room, never past an edge, and as tall as fits with the rest scrolling.
Escape, Tab, a choice, a press, a scroll or a wheel outside it, a resize or the window losing the focus close it, and the focus goes back where it was; a choice closes it before the item acts, so a dialog the item opens has the focus.
An item may open a submenu, the same list beside it, flush with the menu toward the end of the line, or toward its start or over it where the window has not the room, with its first item level with the one that opened it.
The arrow toward the end of the line, Enter, Space or a press opens it at its first item, and the arrow back or Escape closes it alone, the focus back on its item; a mouse or a pen resting 200 ms on the item opens it and resting 300 ms on another closes it, so a diagonal way into it is not lost, and a touch opens it only by a tap.
Fill… is a dialog of the frame's, a sheet on compact and a drawer elsewhere.
It asks the contents first, the fill color, the stroke color, Color… with a color field of its own, or Content-Aware, each with its swatch, then the blending: a mode from the layers' own list, an opacity and Preserve transparency.
The focus starts on the contents chosen, Enter applies from any control but a button or a text field, and Escape or Cancel leaves the layer as it was.
It opens at what was last applied, for the page's life, as Photoshop's does; a Cancel changes nothing.
Rejected: a Fill submenu of the context menu, which cannot hold a mode and an opacity, and a fill option on the fill tool, which floods by tolerance and is not the area's.
Modify… is a dialog of the frame's too, Photoshop's Select > Modify in one dialog rather than five: Expand, Contract, Smooth, Border or Feather, each with a line saying what it does, and a radius in px, 1 to 500, or to 200 for Border, and 0 to 250 for Feather, as Photoshop's are.
One radius serves the four that change the outline, and a way with a smaller range shows it at that range's end without forgetting it.
Feather's is the area's own feather, which it sets rather than changes by, so it starts at what the area has, and 0 is a hard edge.
The focus starts on the way chosen, Enter applies from any control but a button or a text field, and it opens at what was last applied, for the page's life, or at Feather from Shift F6.
Feather was a dialog and an item of its own until 2026-11-05; it joined Modify… so the menu and the selection bar carry one item for the area's shape and edge, as Photoshop's Select > Modify holds Feather with the other four.
A Modify that would leave nothing selected is not applied, and a notice says so, since an area is not a step of the history and could not be had back.
Rejected: a submenu of five dialogs, which is five places for one radius.
A tool that does nothing on the active layer's kind says so and is not available, rather than doing something else.
The tool bar shows only the tools that act on the active layer's kind (`availableOn`, `tools/index.ts`): on a vector layer no Smudge, Remove or Red eye, on a raster layer no Node, Pen or Text, and on a group the move tool, which picks a layer inside it with Auto-select, and Hand, Zoom and Crop; with no layer, every tool.
The tool in hand stays, faded and still pressed, where the layer made active has no use for it, so a change of layer never takes the tool from under the hand; it goes once another is chosen, and its key still picks it.
Rejected: switching to another tool when the layer changes, which loses the tool the user meant to come back to, and Photoshop's every tool always shown, which on a phone's one row is a row of tools that do nothing there.

**The layers panel's menu.**
The layer actions are one menu (`drawing/panels/layerMenu.ts`), the same under the panel's ⋯ button and over a row, where a right-click opens it at the pointer, as do a long press where the browser makes a `contextmenu` of one and the Menu key, and Shift F10 under the row, opened on the keydown as the canvas's is.
A row not among the chosen is chosen alone first, and a row among them keeps the choice, as in Photoshop and every file manager.
The rename field keeps the browser's menu, for its text, and the grip opens none, since a finger held there is a drag about to begin.
The menu lists only what applies to the layers chosen, a rule between its kinds (grouping, a step up or down, and what acts on the active layer alone), and the ⋯ button is disabled when nothing does; an item that applies but will not be done, a merge of a hidden layer, is listed and says why.
This is the opposite of the canvas's menu, which shows disabled what cannot be done: the canvas's list is one for every selection, learned once, where the layer menu is about the layers chosen, which already say what applies, and a list of disabled merges and clips for a group of several is noise.
The panel's head is New, a menu of a vector layer, a raster layer and a group; Duplicate; Delete; and the ⋯ menu.
Move up and Move down left the head on 2026-11-06, once a row could be dragged, and stay in the menu so a layer can be moved without a drag (WCAG 2.5.7).

**The layers panel's previews.**
Each layer's row shows a picture of the layer where its kind's icon was, as Photoshop's layer thumbnails do, and a vector layer's picture carries a small vector mark in its corner; a raster layer's carries none, and a group keeps its folder, as Photoshop's does.
A vector layer of two or more items is expandable just as a group is: its picture is its disclosure, with a caret on its other corner that turns as the group's does, so no row moves over for it, and its items are listed under it a level deeper, each with its name and its picture, framed on the item as Illustrator's are, where a layer's shows the whole canvas as Photoshop's does.
A press on an item selects it on the canvas with the move tool, as Illustrator's layers panel does, and an item selected on the canvas is shown selected in the panel.
An item's menu is the selection's actions, the canvas's own list, not the layer's: a press on the item selects it, so the menu is about what is selected, and one list for both is one that cannot drift.
Items are dragged, as Illustrator's are, to arrange them within their layer or move them into another vector layer, each one command (`document/elements.ts`), and Alt with an arrow is a step of Arrange for the keyboard, as it is a step of the stack for layers; dragging items was rejected until 2026-11-06, as other commands than the panel's, until those commands were written.
A held layer's items, locked or hidden, are seen and never reached from the panel, as the canvas's tools never reach them, so the panel is no way round a lock.
Rejected: a caret column that moves every row over; vector layers starting open, which floods the panel with a layer of strokes; an item's right-click opening its layer's menu, which is about the layer when the press was about the item; a copy of the drawing in each row, which puts the drawing into the panel's DOM outside the shadow root, where its `<style>` reaches the app; and keeping every definition in each picture, which would draw every picture again for a change to one layer's adjustment.

**The Image menu.**
The top bar's More holds Photoshop's Image menu as a group of its own after Export: Image size…, Canvas size…, Image rotation, Trim… and Reveal all, in its order and under its names (`drawing/panels/imageMenu.tsx`, done by `drawing/document/canvasOps.ts`).
Image rotation is a submenu of 180°, 90° clockwise, 90° counterclockwise and Arbitrary…, then Flip canvas horizontal and Flip canvas vertical, each done at once as one step of undo, as Reveal all is.
Image size… asks a width and a height in px, Constrain proportions and Resample, both on as Photoshop starts them: everything drawn scales with the canvas, and with Resample a raster layer's pixels are made again at the new size rather than stretched.
Canvas size… asks a width and a height, or with Relative how much to add or take away, and an anchor, Photoshop's nine squares, which says where what is drawn stays as the canvas grows or is cut around it; nothing drawn moves or scales, and what the canvas gains is clear, as a new drawing is.
Arbitrary… asks an angle and a direction, and the canvas grows to hold what was on it, as Photoshop's does.
Trim… asks what is cut away, transparent pixels or the top left or the bottom right pixel's color, and from which sides; Reveal all grows the canvas to hold every layer's paint.
A dialog is a sheet on compact and a drawer elsewhere, made as Fill… and Modify… are (`components/ui/DialogForm.tsx`): it starts at the canvas as it is and at the choices last applied, for the page's life, with the focus on its first field; Enter applies from any control but a button or a text field; and Escape, Cancel or a tap beside it changes nothing.
An operation that would change nothing is not done and a notice says so, and one that measures or reads pixels first is not done, and a notice says so, if the drawing changed meanwhile.
The items are shown disabled while a selection is being transformed or an operation is running, as the canvas's menu shows what cannot be done, and the view refits to the new canvas.

**The brush's outline.**
Every tool with a size shows it as its pointer over the canvas, as Photoshop's Normal Brush Tip does: a circle as big on the screen as what the tool will paint, which grows and shrinks with the zoom and follows `[`, `]` and the Size slider at once, with a small crosshair at its middle, and the crosshair alone where the circle would be too small to see.
It is drawn as a light halo under a dark hairline, so it reads on any picture, and shows the whole size whatever the pressure, as Photoshop's does.
A soft brush's circle is where its paint is half opaque, which is where its mark is seen to end, as Photoshop's Normal Brush Tip; a hard one's is its size.
Pressure changes a stroke's width only from a pen, as in Photoshop, so a mouse or a finger paints the size the circle shows.
The system's pointer is hidden while it shows, and the tool's crosshair is there before it first does; a finger has no hover and covers the brush, so it is never shown for one.
The size is the drawing's, in its units, on any layer: what lands on a layer scaled by its transform is as big on the screen as the outline was.

**The tool bar.**
The tools are in Photoshop's groups and in its order (`drawing/tools/groups.ts`): the move tool; Marquee, Lasso and Magic wand; Crop and Eyedropper; Remove, Red eye and Smudge; Brush, Pencil, Eraser and Fill; Pen, Text and Node, which is Photoshop's Direct Selection beside its pen and type; Rectangle, Ellipse and Line; Hand and Zoom.
A light rule parts each group from the next, the one rule every bar draws (`ToolBarRule`), and a group left with no tool on the active layer is not there, nor its rule.
Where the bar has the room, every tool is a button.
Where it has not, groups fold one at a time, the largest first and of two as large the later, until the bar holds them, each into one button that shows the tool last used in it and a mark in its corner, as a slot of Photoshop's tool bar does.
A press on a folded group picks the tool it shows; a long press, a right-click or the menu key opens its menu, its tools by icon, name and key with the one in hand checked; and a tool's key picks it folded or not.
The bar is measured, not the window: a `ResizeObserver` on the room the colors and the layers leave the tools (`panels/ToolGroups.tsx`), so a rail on a short window folds and a tall one shows every tool.
Where even every group folded is too long, as a phone's one row is with 44 px targets, the row scrolls.
Rejected: Photoshop's slots folded always, which hides tools behind a long press on a desktop with the room to show them; and a second column, which takes the canvas's room on a narrow window for tools seldom used together.

Rejected: a component library, which brings tokens of its own to reconcile with the brand's and more than this app uses, when the set here is small and in the house style already; an icon font or icon package, when thirty line icons at 24 px are drawn by hand in `icons.tsx` and cost nothing to load; touch and mouse events beside pointer events, which is the same stroke handled twice; a "simplified" phone editor with fewer tools, since the tools are the product and the screen only decides where they sit.
