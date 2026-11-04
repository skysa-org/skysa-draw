/**
 * The namespaces the document module tells apart (docs/ARCHITECTURE.md §7,
 * "The editor"; §9): the three whose elements a browser makes live, XLink and
 * XML, whose attributes SVG reads, and the one namespace declarations are in.
 * In a module of their own so the layers and the commands can name them
 * without loading the sanitizer, which builds a DOMPurify instance as it loads.
 */

export const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';

export const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

/** `xml:space`, `xml:lang`: SVG reads them, so the sanitizer judges them as it does SVG's own. */
export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

/** Where every `xmlns` and `xmlns:*` attribute is. */
export const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

/** Inkscape's, whose `inkscape:label` is read as a layer's name and never written (§3, "Layers"). */
export const INKSCAPE_NAMESPACE = 'http://www.inkscape.org/namespaces/inkscape';
