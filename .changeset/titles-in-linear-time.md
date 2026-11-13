---
'@skysa/draw-core': patch
---

A drawing's title and size are read in time to the file's length. A long run of whitespace or comments before no title, or a `width` of many digits or spaces, held the tab for seconds or more each time the file was read.
A comment before a title ends at its first `-->`, as XML's do: a malformed one with text after that close is no longer read past to find a title, so such a file is named by its filename.
