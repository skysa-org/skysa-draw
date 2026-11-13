---
'@skysa/draw-core': patch
---

Renaming a drawing whose title closes itself, `<title/>`, no longer takes away everything up to the next `</title>`, such as a layer whose shapes have titles of their own: such a title is an empty one, and is replaced where it is.
A title's start tag is read as the root's is, so a `>` in a quoted value no longer ends it.
SVG's title is read under whatever prefix binds it.
Under a root such as `svg:svg`, where SVG is not the default namespace, a title is written under the root's prefix, so that it is SVG's, and a `<title>` with no prefix is not taken for it.
A drawing's title and size are read, and its id and title written, in time to the file's length.
A long run of whitespace or comments before no title, a `width` of many digits or spaces, or a long run of whitespace inside the root tag held the tab for seconds or more each time the file was read or written.
A comment before a title ends at its first `-->`, as XML's do: a malformed one with text after that close is no longer read past to find a title, so such a file is named by its filename.
