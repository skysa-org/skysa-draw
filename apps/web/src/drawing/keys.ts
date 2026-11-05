import { type AreaMode, TOOL_IDS, type ToolId } from './tools/types.js';

/**
 * The keys (docs/decisions/0004-the-interface.md; docs/ARCHITECTURE.md §7,
 * "Input"): a letter per tool and the editing keys users know, in one map, so
 * a dispute about a key is settled in one place. Pure over the event's fields;
 * the frame listens and asks here what a key means.
 */

/** The letter that picks each tool, as Figma, Illustrator, Photoshop and Krita agree on it. */
export const TOOL_KEYS: Readonly<Record<ToolId, string>> = {
	select: 'V',
	node: 'A',
	hand: 'H',
	zoom: 'Z',
	pencil: 'N',
	brush: 'B',
	eraser: 'E',
	smudge: 'S',
	// Photoshop's healing group: J picks it, Shift J goes round it.
	remove: 'J',
	redEye: 'J',
	fill: 'G',
	eyedropper: 'I',
	rectangle: 'R',
	ellipse: 'O',
	line: 'L',
	pen: 'P',
	text: 'T',
	marquee: 'M',
	lasso: 'Q',
	wand: 'W',
	crop: 'C',
};

export const EDIT_ACTIONS = [
	'undo',
	'redo',
	'fit',
	'actualSize',
	'zoomIn',
	'zoomOut',
	'delete',
	'escape',
	'sizeUp',
	'sizeDown',
	'swapColors',
	'resetColors',
	'newLayer',
	'duplicate',
	'selectAll',
	'deselect',
	'selectInverse',
	'feather',
	'layerViaCut',
	'fillArea',
	'fillAreaStroke',
	'fillDialog',
	'commit',
] as const;

export type EditAction = (typeof EDIT_ACTIONS)[number];

/** What is read of a keyboard event: the key and its modifiers, and where it was aimed. */
export type KeyLike = Readonly<{
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	target?: EventTarget | null;
}>;

const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Whether the keys are going into a field, where a letter is a letter and not a tool. */
export const isTyping = (target: EventTarget | null | undefined): boolean =>
	target instanceof Element && target.closest(TYPING) !== null;

/** The controls Space presses, as a browser presses a button with it. */
const PRESSED_BY_SPACE =
	'button, summary, [role="button"], [role="checkbox"], [role="switch"], [role="radio"], [role="tab"], [role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/** The controls Enter presses or follows: Space's, and links. */
const PRESSED_BY_ENTER = `${PRESSED_BY_SPACE}, a[href], [role="link"]`;

/**
 * Whether the key would press the control the keys go to, one of
 * `controls`: one the keyboard brought the focus to, and not the one the
 * last pointer press was in (`pressed`, `viewport/pointerPressed.ts`),
 * which keeps the focus in Chrome, so that Space held after a tool is
 * clicked still pans.
 */
const pressesControl = (
	target: EventTarget | null | undefined,
	pressed: Node | null | undefined,
	controls = PRESSED_BY_SPACE
): boolean =>
	target instanceof Element &&
	target.matches(controls) &&
	!(pressed instanceof Node && target.contains(pressed));

/**
 * Whether the key is the one held for the hand, whatever the tool: Space, as
 * in every editor, bare and outside a field, and not on a control the
 * keyboard is on, which Space presses. `pressed` is what the last pointer
 * press landed on. The viewport pans while it is down; its keyup is read as
 * any Space, so a modifier pressed meanwhile does not leave the hand held.
 */
export const isHandKey = (event: KeyLike, pressed?: Node | null): boolean =>
	event.key === ' ' &&
	!event.ctrlKey &&
	!event.metaKey &&
	!event.altKey &&
	!isTyping(event.target) &&
	!pressesControl(event.target, pressed);

/**
 * Whether Enter is the canvas's, to finish what is under way (`commit`):
 * Transform selection's Apply. Bare, outside a field, and not on a control
 * the keyboard is on, whose own Enter it is, as Space's is (`isHandKey`); a
 * control the last pointer press was in keeps the focus in Chrome, but the
 * key is not aimed at it, and is the canvas's.
 */
export const isCommitKey = (event: KeyLike, pressed?: Node | null): boolean =>
	event.key === 'Enter' &&
	!event.ctrlKey &&
	!event.metaKey &&
	!event.altKey &&
	!event.shiftKey &&
	!isTyping(event.target) &&
	!pressesControl(event.target, pressed, PRESSED_BY_ENTER);

/** The arrows' nudge in the layer's pixels: one, or ten with Shift, as Photoshop's move tool's. */
const NUDGES: Readonly<Record<string, readonly [number, number]>> = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1],
};

/** How far an arrow nudges what is selected; none with another modifier, or in a field. */
export const nudgeFor = (event: KeyLike): readonly [number, number] | undefined => {
	const step = NUDGES[event.key];
	if (step === undefined || event.ctrlKey || event.metaKey || event.altKey) return undefined;
	if (isTyping(event.target)) return undefined;
	const by = event.shiftKey ? 10 : 1;
	return [step[0] * by, step[1] * by];
};

/** Which of the two keys were held as a drag or a click began. */
export type Held = Readonly<{ shiftKey: boolean; altKey: boolean }>;

/**
 * The keys that, held as a selection tool's drag or click begins, make it in
 * a mode whatever the option says, as in Photoshop: Shift adds, Alt
 * subtracts, and both intersect. A new selection has none: it is the
 * option's with neither held. The options strip's tooltips read it too.
 */
const MODE_KEYS: readonly (readonly [AreaMode, Held])[] = [
	['add', { shiftKey: true, altKey: false }],
	['subtract', { shiftKey: false, altKey: true }],
	['intersect', { shiftKey: true, altKey: true }],
];

/** The keys that make a drag or a click in `mode`; none for a new selection. */
export const areaModeKeys = (mode: AreaMode): Held | undefined =>
	MODE_KEYS.find(([each]) => each === mode)?.[1];

/**
 * The mode a drag or a click is made in: the one its keys make, else the
 * option's (`ToolOptions.areaMode`).
 */
export const areaModeOf = (held: Held, option: AreaMode): AreaMode =>
	MODE_KEYS.find(
		([, keys]) => keys.shiftKey === held.shiftKey && keys.altKey === held.altKey
	)?.[0] ?? option;

/** The tools each letter picks, in the order the tool bar lists them: one, or a group, as Photoshop's are. */
const toolsOfKey = (letter: string): readonly ToolId[] =>
	TOOL_IDS.filter((id) => TOOL_KEYS[id] === letter);

/**
 * The tool a letter picks, in either case, so Caps Lock changes nothing.
 * A letter shared by a group, as Photoshop's J is its healing tools', picks
 * the first of them, or keeps the one in hand where that is of the group;
 * Shift with it goes to the group's next, as Photoshop's Shift J does, and
 * with a letter of one tool Shift picks nothing. No other modifier picks a
 * tool, so the platform does not matter here; the parameter is taken so
 * the frame calls this and `editActionFor` alike.
 */
export const toolFor = (event: KeyLike, _isMac: boolean, current?: ToolId): ToolId | undefined => {
	if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
	if (event.key.length !== 1 || isTyping(event.target)) return undefined;
	const group = toolsOfKey(event.key.toUpperCase());
	const at = current === undefined ? -1 : group.indexOf(current);
	if (!event.shiftKey) return at === -1 ? group[0] : current;
	return group.length > 1 ? group[(at + 1) % group.length] : undefined;
};

/** A single character lowered, so Shift and Caps Lock read the same; a named key as it is. */
const keyOf = (event: KeyLike): string =>
	event.key.length === 1 ? event.key.toLowerCase() : event.key;

/**
 * With the primary key alone. J is Photoshop's: layer via copy while
 * something is selected, and the layer duplicated while nothing is, which
 * the viewport tells apart, as it holds the selection. Backspace is
 * Photoshop's fill with the background color, here the stroke color; in a
 * field it deletes a word, and stays the field's.
 */
const PRIMARY_ACTIONS: Readonly<Record<string, EditAction>> = {
	z: 'undo',
	y: 'redo',
	'0': 'fit',
	'1': 'actualSize',
	'=': 'zoomIn',
	'+': 'zoomIn',
	'-': 'zoomOut',
	j: 'duplicate',
	a: 'selectAll',
	d: 'deselect',
	Backspace: 'fillAreaStroke',
};

/**
 * With Shift as well: redo, a new layer, and zoom in, since Shift is how `=`
 * becomes `+`. The new layer's is Photoshop's, GIMP's and Affinity's key, and
 * a browser keeps it for a private window, so a page in a tab never hears it;
 * an installed app's window may, and Insert (`BARE_ACTIONS`) is there for the
 * rest. Select inverse and layer via cut are Photoshop's and Krita's; Chrome
 * on Windows and Linux keeps Ctrl+Shift+I for its developer tools, so there
 * the context menu and the selection bar are the way to it, as the layers
 * panel is to a new layer on a Mac.
 */
const PRIMARY_SHIFT_ACTIONS: Readonly<Record<string, EditAction>> = {
	z: 'redo',
	n: 'newLayer',
	'=': 'zoomIn',
	'+': 'zoomIn',
	i: 'selectInverse',
	j: 'layerViaCut',
};

/**
 * With no modifier at all, Shift included: Insert, Krita's key for a new
 * layer, which a tab does hear, where Shift and Insert is paste on Windows and
 * Linux.
 */
const BARE_ACTIONS: Readonly<Record<string, EditAction>> = {
	Insert: 'newLayer',
	// What is under way is done, as Photoshop's Enter applies a transform; Escape is its cancel.
	Enter: 'commit',
};

/**
 * With Shift and nothing else, Photoshop's: Feather is Shift+F6, and Fill…
 * Shift+F5 and Shift+Backspace. F6 alone is the browser's, to its address
 * bar, and F5 alone its reload; Shift+F5 is a reload past the cache in
 * Chrome on Windows and Linux, which the viewport keeps from the browser only
 * where there is an area to fill. Shift with Delete is still a delete.
 */
const SHIFT_ACTIONS: Readonly<Record<string, EditAction>> = {
	F5: 'fillDialog',
	F6: 'feather',
	Backspace: 'fillDialog',
};

/**
 * With Alt, Option on a Mac, and nothing else: the area filled with the fill
 * color, Photoshop's fill with the foreground color. The one Alt key the map
 * reads; every other is a menu's on Windows, or types a character on a Mac.
 */
const ALT_ACTIONS: Readonly<Record<string, EditAction>> = {
	Backspace: 'fillArea',
};

/**
 * With no primary key; Shift reads the same as none, as Caps Lock does. X
 * swaps the two colors and D puts back the defaults, Photoshop's keys for its
 * foreground and background; D with the primary key is deselect.
 */
const PLAIN_ACTIONS: Readonly<Record<string, EditAction>> = {
	Delete: 'delete',
	Backspace: 'delete',
	']': 'sizeUp',
	'[': 'sizeDown',
	x: 'swapColors',
	d: 'resetColors',
};

/** Alt with no other modifier, AltGr included in none, since it is Ctrl and Alt on Windows. */
const altActionFor = (event: KeyLike): EditAction | undefined =>
	event.ctrlKey || event.metaKey || event.shiftKey ? undefined : ALT_ACTIONS[event.key];

/**
 * The editing action a key asks for: with the primary key, ⌘ on a Mac and
 * Ctrl elsewhere, the ones users know from every editor; without one, the
 * bare keys, and Alt with Backspace. None while typing in a field, where
 * Backspace deletes a letter and Alt with it a word, except Escape, which
 * always means stop.
 */
export const editActionFor = (event: KeyLike, isMac: boolean): EditAction | undefined => {
	if (event.key === 'Escape') return 'escape';
	if (isTyping(event.target)) return undefined;
	if (event.altKey) return altActionFor(event);
	const primary = isMac ? event.metaKey : event.ctrlKey;
	if (primary) return (event.shiftKey ? PRIMARY_SHIFT_ACTIONS : PRIMARY_ACTIONS)[keyOf(event)];
	// The other platform's primary key is not a bare key either.
	if (event.ctrlKey || event.metaKey) return undefined;
	const modified = event.shiftKey ? SHIFT_ACTIONS[event.key] : BARE_ACTIONS[event.key];
	return modified ?? PLAIN_ACTIONS[keyOf(event)];
};

/** The letter shown beside a tool's name. */
export const shortcutLabel = (id: ToolId): string => TOOL_KEYS[id];

/** The primary key's name beside an editing action: the glyph on a Mac's keyboard, the word on others'. */
export const primaryKeyLabel = (isMac: boolean): string => (isMac ? '⌘' : 'Ctrl');

/** A key and what is held with it, as a menu shows it beside an action. */
type Chord = Readonly<{ key: string; primary?: boolean; shift?: boolean; alt?: boolean }>;

/**
 * The key shown for each action that has one: one of the keys the maps above
 * read as it (a test holds each to that), the one users know it by. None on
 * a Mac for a new layer: a Mac has no Insert, and a tab never hears ⇧⌘N.
 */
const SHORTCUTS: Readonly<Partial<Record<EditAction, Chord>>> = {
	undo: { key: 'Z', primary: true },
	redo: { key: 'Z', primary: true, shift: true },
	fit: { key: '0', primary: true },
	actualSize: { key: '1', primary: true },
	zoomIn: { key: '+', primary: true },
	zoomOut: { key: '-', primary: true },
	delete: { key: 'Delete' },
	newLayer: { key: 'Insert' },
	duplicate: { key: 'J', primary: true },
	selectAll: { key: 'A', primary: true },
	deselect: { key: 'D', primary: true },
	selectInverse: { key: 'I', primary: true, shift: true },
	feather: { key: 'F6', shift: true },
	layerViaCut: { key: 'J', primary: true, shift: true },
	fillArea: { key: 'Backspace', alt: true },
	fillAreaStroke: { key: 'Backspace', primary: true },
	fillDialog: { key: 'F5', shift: true },
	swapColors: { key: 'X' },
	resetColors: { key: 'D' },
	commit: { key: 'Enter' },
	escape: { key: 'Escape' },
};

/** The keys a Mac's keyboard prints as a glyph; its delete key is Backspace, which deletes here too. */
const MAC_GLYPHS: Readonly<Record<string, string>> = {
	Backspace: '⌫',
	Delete: '⌫',
	Enter: '↩',
	Escape: '⎋',
};

/** The keys other keyboards print short. */
const KEY_NAMES: Readonly<Record<string, string>> = { Escape: 'Esc' };

/** A chord as each platform writes one: `⇧⌘I`, in Apple's order, on a Mac; `Ctrl+Shift+I` elsewhere. */
const chordLabel = (chord: Chord, isMac: boolean): string => {
	if (isMac) {
		const held = [
			chord.alt === true && '⌥',
			chord.shift === true && '⇧',
			chord.primary === true && '⌘',
		];
		return `${held.filter((glyph) => glyph !== false).join('')}${MAC_GLYPHS[chord.key] ?? chord.key}`;
	}
	const held = [
		chord.primary === true && 'Ctrl',
		chord.shift === true && 'Shift',
		chord.alt === true && 'Alt',
	];
	return [...held.filter((name) => name !== false), KEY_NAMES[chord.key] ?? chord.key].join('+');
};

/** The key shown beside an action in a menu or a tooltip; none for an action without one here. */
export const shortcutFor = (action: EditAction | undefined, isMac: boolean): string | undefined => {
	if (action === undefined || (isMac && action === 'newLayer')) return undefined;
	const chord = SHORTCUTS[action];
	return chord === undefined ? undefined : chordLabel(chord, isMac);
};
