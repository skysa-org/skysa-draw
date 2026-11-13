---
'@skysa/draw-core': patch
'@skysa/draw-web': patch
---

Renaming a drawing whose title closes itself, `<title/>`, no longer takes away everything up to the next `</title>`, such as a layer whose shapes have titles of their own: such a title is an empty one, and is filled where it is.
A title that could end in two places is not read, and a rename puts a new title ahead of it and takes nothing away: one whose start tag ends in a bare value that runs into its `/>`, as `<title id=t/>`, and one whose first `</title>` a comment, CDATA section or processing instruction in it holds or runs past, or an element of its own name inside it closes.
On 0.1.0, renaming such a title could take away the layers after it, or leave an end tag with nothing to close, so that no XML parser read the file.
Giving a drawing its id no longer writes into another attribute's value that holds the same characters, which could leave a file that is no longer a drawing.
Where a root has the id attribute twice, or binds the app's namespace under two prefixes, the id read is the one replaced; where it has one in an undeclared namespace, the namespace is declared with it; and a free prefix for the app's namespace is found however many are taken, in core and in the editor.
Where a value without quotes in the root tag ends in a slash before its `>`, as `xml:base=http://a/b/>`, the id is written after it, as the root is read, instead of taking the slash for the tag's close and changing the value.
A start tag is read by a scanner instead of a pattern, so one with millions of attributes no longer runs out of stack.
A rename keeps the title's own start tag and its attributes, so an `id` that the root's `aria-labelledby` names still names it.
A title's start tag is read as the root's is, so a `>` in a quoted value no longer ends it.
SVG's title is read under whatever prefix binds it, and after a processing instruction, as XML allows one there; where SVG is the root's default namespace, a rename names it `title`, as the editor keeps it.
Under a root such as `svg:svg`, where SVG is not the default namespace, a new title is written under the root's prefix, so that it is SVG's; a `<title>` in no namespace, as 0.1.0 wrote there, is still read, and a rename makes SVG's namespace its default, keeping its attributes.
Characters that XML does not allow, such as most control characters, are left out of a title, written or read, in the file and in the drawing's row alike, so a pasted name no longer leaves a file that no parser reads, and one made of nothing else changes nothing.
A drawing's title and size are read, and its id and title written, in time to the file's length.
A long run of whitespace or comments before no title, a `width` of many digits or spaces, or a long run of whitespace inside the root tag held the tab for seconds or more each time the file was read or written.
A comment before a title ends at its first `-->`, as XML's do: a malformed one with text after that close is no longer read past to find a title, so such a file is named by its filename.
