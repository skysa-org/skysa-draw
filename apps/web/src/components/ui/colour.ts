/**
 * The colour field's small, pure converter (docs/ARCHITECTURE.md §7, "The
 * interface"): a CSS colour as a drawing writes it — `#rgb`, `#rrggbb`,
 * `rgb()` as a browser's computed style has it, or one of the named colours —
 * to the `#rrggbb` a native colour picker takes. Anything else, including a
 * colour that is not opaque, has no such form and is `undefined`.
 */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `rgb()` or `rgba()`, commas or spaces, with the alpha, if any, caught to be checked. */
const RGB =
	/^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/;

/** An alpha that leaves the colour opaque, so that dropping it loses nothing. */
const isOpaque = (alpha: string | undefined): boolean =>
	alpha === undefined || (alpha.endsWith('%') ? parseFloat(alpha) >= 100 : Number(alpha) >= 1);

/**
 * The CSS named colours (https://www.w3.org/TR/css-color-4/#named-colors), as
 * `name:rrggbb`, so the table is read in one glance rather than down a page.
 */
const NAMED_TABLE = `
aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc
bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a
burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50
cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b
darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b
darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000
darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f
darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff
dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0
forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520
gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4
indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5
lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff
lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1
lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899
lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32
linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd
mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee
mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970
mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6
olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa
palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9
peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399
red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460
seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd
slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c
teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff
whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32
`;

const NAMED: ReadonlyMap<string, string> = new Map(
	NAMED_TABLE.trim()
		.split(/\s+/)
		.map((entry) => entry.split(':'))
		.flatMap(([name, hex]): [string, string][] =>
			name !== undefined && hex !== undefined ? [[name, `#${hex}`]] : []
		)
);

/** `none`: no fill, or no stroke, as SVG spells it. */
export const isNone = (value: string): boolean => value.trim().toLowerCase() === 'none';

/** `#rgb` or `#rrggbb`, in either case: what the hex field takes. */
export const isValidHex = (value: string): boolean => HEX.test(value.trim());

const channel = (text: string): string => Math.min(255, Number(text)).toString(16).padStart(2, '0');

/** The colour as `#rrggbb`, lower case, or `undefined` for one that has no such form. */
export const toHex = (value: string): string | undefined => {
	const text = value.trim().toLowerCase();
	if (HEX.test(text)) {
		if (text.length === 7) return text;
		return `#${[...text.slice(1)].map((digit) => digit + digit).join('')}`;
	}
	const rgb = RGB.exec(text);
	if (rgb === null) return NAMED.get(text);
	if (!isOpaque(rgb[4])) return undefined;
	return `#${rgb.slice(1, 4).map(channel).join('')}`;
};
