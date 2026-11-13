---
'@skysa/draw-core': patch
'@skysa/draw-web': patch
---

Renaming a drawing whose title closes itself, `<title/>`, no longer takes away everything up to the next `</title>`, such as a layer whose shapes have titles of their own: such a title is an empty one, and is filled where it is.
A title that could end in two places is not read, and a rename puts a new title ahead of it and takes nothing away: one whose start tag ends in a bare value that runs into its `/>`, as `<title id=t/>`, and one whose first `</title>` something in it holds or runs past.
That something is a comment, a CDATA section, a processing instruction, a start or end tag whose quoted value holds it, a `<` or `</` before a name that no `>` closes, or a `<!`, or a `</` before anything but an ASCII letter, that an HTML parser reads as a comment; so is a comment or instruction that an HTML parser ends sooner than XML, at its first `>` or a `--!>`.
So is a tag of the title's own name in any case, closing itself or not, as `<title/>`, or of an element whose text HTML reads as text, as `<textarea>` or `<script/>`, and an end tag of its name that XML does not end it at and HTML does, as `</TITLE>` or `</title x>`.
An end tag with a space XML does not count as one before its `>`, as a no-break space, does not end a title either.
A title in which an element is opened and not closed before its first `</title>`, which no XML parser reads and an HTML parser ends past it, is still read up to that end tag, as on 0.1.0, and a rename leaves what follows it.
On 0.1.0, renaming such a title could take away the layers after it, or leave an end tag with nothing to close, so that no XML parser read the file.
Giving a drawing its id no longer writes into another attribute's value that holds the same characters, which could leave a file that is no longer a drawing.
Where a root has the id attribute twice, the one read is the one replaced.
Where a root binds the app's namespace under two prefixes and has the id only under the second, which is not read, as it never was, giving the drawing its id writes it under the first in that one's place, instead of beside it as a second attribute of the same expanded name, which XML parsers refuse.
Where a root has the id in an undeclared namespace, the namespace is declared with it.
Giving a drawing the id it already has keeps the file's bytes, however the attribute is written, so a save undone back to what it was is no change.
A free prefix for the app's namespace is found however many are taken, in core and in the editor.
Where a value without quotes in the root tag ends in a slash before its `>`, as `xml:base=http://a/b/>`, the id is written after it, as the root is read, instead of taking the slash for the tag's close and changing the value.
A start tag is read by a scanner instead of a pattern, so one with hundreds of thousands of attributes no longer runs out of stack, in core or in an export, which now sets the root's size through core's `withDrawingViewport`.
A root with more than a million, which the pattern could not read either, is not a drawing, so the memory a file can take to read is bounded; the app's namespace and id are not counted, so a root given its id is read as it was.
A title with more than a million is not read, though 0.1.0 read one, and a rename puts a new title ahead of it; its `xmlns` are not counted, so one a rename makes SVG's is read again.
A rename keeps the title's own start tag and its attributes, so an `id` that the root's `aria-labelledby` names still names it; where its last value is bare and ends in a slash, a space stays before its `>`, so the title is read back.
A title's start tag is read as the root's is, so a `>` in a quoted value no longer ends it.
SVG's title is read under whatever prefix binds it, and after a processing instruction, as XML allows one there; where SVG is the root's default namespace, a rename names it `title`, as the editor keeps it.
Under a root such as `svg:svg`, where SVG is not the default namespace, a new title is written under the root's prefix, so that it is SVG's; a `<title>` in no namespace, as 0.1.0 wrote there, is still read, and a rename makes SVG's namespace its default, keeping its attributes.
Characters that XML does not allow, such as most control characters, are left out of a title, written or read, in the file and in the drawing's row alike, so a pasted name no longer leaves a file that no parser reads, and one made of nothing else changes nothing.
A reference to half of a surrogate pair is left out of a title read, so two of them no longer make one character that no XML tool shows.
A drawing's title and size are read, and its id and title written, in time to the file's length.
A long run of whitespace or comments before no title, a `width` of many digits or spaces, or a long run of whitespace inside the root tag held the tab for seconds or more each time the file was read or written.
A comment before a title ends at its first `-->`, as XML's do: a malformed one with text after that close is no longer read past to find a title, so such a file is named by its filename.
