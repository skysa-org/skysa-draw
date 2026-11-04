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
On compact the canvas fills the window, the tools are a bar along the bottom under one row of options for the active tool, and the layers and the colour open as sheets over the canvas, one at a time, which is how Procreate and every phone editor arrange it.
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
| Select | V | Pick, move, resize and rotate elements, as `transform` | Move, resize and rotate the layer |
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
| Crop | C | The canvas's `viewBox` | The canvas's `viewBox` |

Undo and redo are Ctrl or ⌘ Z and Shift with it; Ctrl or ⌘ A selects all and D drops the selection, and J duplicates the layer, as in Photoshop; `[` and `]` change a brush's size; X swaps the two colours; Ctrl or ⌘ 0 fits the drawing to the window and 1 shows it at actual size; Delete removes what is selected; Escape cancels what a tool has begun.
A new layer is Insert, Krita's key, with no modifier, since Shift and Ctrl with Insert are paste and copy on Windows and Linux; Photoshop's Ctrl or ⌘ Shift N is kept for an installed window, but a browser tab never receives it, and a Mac keyboard has no Insert, so on a Mac in a tab the layers panel is the way.
The map is one file, `drawing/keys.ts`, so a dispute about a key is settled in one place.
A tool that does nothing on the active layer's kind says so and is not available, rather than doing something else.

Rejected: a component library, which brings tokens of its own to reconcile with the brand's and more than this app uses, when the set here is small and in the house style already; an icon font or icon package, when thirty line icons at 24 px are drawn by hand in `icons.tsx` and cost nothing to load; touch and mouse events beside pointer events, which is the same stroke handled twice; a "simplified" phone editor with fewer tools, since the tools are the product and the screen only decides where they sit.
