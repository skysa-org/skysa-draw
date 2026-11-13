---
'@skysa/draw-core': patch
'@skysa/draw-web': patch
---

Renaming a drawing whose title closes itself, `<title/>`, no longer takes away everything up to the next `</title>`, such as a layer whose shapes have titles of their own: such a title is an empty one, and is filled where it is.
Giving a drawing its id no longer writes into another attribute's value that holds the same characters, which could leave a file that is no longer a drawing.
Where a root has the id attribute twice, or binds the app's namespace under two prefixes, the id read is the one replaced; where it has one in an undeclared namespace, the namespace is declared with it; and a free prefix for the app's namespace is found however many are taken, in core and in the editor.
A start tag is read by a scanner instead of a pattern, so one with millions of attributes no longer runs out of stack.
In the root tag, a value without quotes that runs into the tag's close, as `height=10/>`, ends before the slash where no end tag follows, so the tag closes itself, as its author meant; where `</svg>` follows, as after `xml:base=http://a/b/>`, the slash is the value's.
A title whose start tag ends that way, as `<title id=t/>`, could be read either way, so it is not read: a rename puts a new title ahead of it and takes nothing away.
A rename keeps the title's own start tag and its attributes, so an `id` that the root's `aria-labelledby` names still names it.
A title's start tag is read as the root's is, so a `>` in a quoted value no longer ends it.
A `</title>` inside a comment or a CDATA section in the title is no longer taken for its end.
SVG's title is read under whatever prefix binds it.
Under a root such as `svg:svg`, where SVG is not the default namespace, a title is written under the root's prefix, so that it is SVG's; a `<title>` in no namespace, as 0.1.0 wrote there, is still read, and a rename writes it as SVG's, keeping its other attributes.
Characters that XML does not allow, such as most control characters, are left out of a title when it is written, so a pasted name no longer leaves a file that no parser reads.
A drawing's title and size are read, and its id and title written, in time to the file's length.
A long run of whitespace or comments before no title, a `width` of many digits or spaces, or a long run of whitespace inside the root tag held the tab for seconds or more each time the file was read or written.
A comment before a title ends at its first `-->`, as XML's do: a malformed one with text after that close is no longer read past to find a title, so such a file is named by its filename.
