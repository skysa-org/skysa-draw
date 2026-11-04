import { TOOL_IDS, type ToolId } from './tools/types.js';

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
	fill: 'G',
	eyedropper: 'I',
	rectangle: 'R',
	ellipse: 'O',
	line: 'L',
	pen: 'P',
	text: 'T',
	marquee: 'M',
	lasso: 'Q',
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
	'swapColours',
	'newLayer',
	'duplicate',
	'selectAll',
	'deselect',
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

/**
 * Whether the key is the one held for the hand, whatever the tool: Space, as
 * in every editor, bare and outside a field. The viewport pans while it is
 * down; its keyup is read as any Space, so a modifier pressed meanwhile does
 * not leave the hand held.
 */
export const isHandKey = (event: KeyLike): boolean =>
	event.key === ' ' &&
	!event.ctrlKey &&
	!event.metaKey &&
	!event.altKey &&
	!isTyping(event.target);

const KEY_TOOLS: ReadonlyMap<string, ToolId> = new Map(TOOL_IDS.map((id) => [TOOL_KEYS[id], id]));

/**
 * The tool a bare letter picks, in either case, so Caps Lock changes nothing.
 * No tool key has a modifier, so the platform does not matter here; the
 * parameter is taken so the frame calls this and `editActionFor` alike.
 */
export const toolFor = (event: KeyLike, _isMac: boolean): ToolId | undefined => {
	if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return undefined;
	if (event.key.length !== 1 || isTyping(event.target)) return undefined;
	return KEY_TOOLS.get(event.key.toUpperCase());
};

/** A single character lowered, so Shift and Caps Lock read the same; a named key as it is. */
const keyOf = (event: KeyLike): string =>
	event.key.length === 1 ? event.key.toLowerCase() : event.key;

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
};

/**
 * With Shift as well: redo, a new layer, and zoom in, since Shift is how `=`
 * becomes `+`. The new layer's is Photoshop's, GIMP's and Affinity's key, and
 * a browser keeps it for a private window, so a page in a tab never hears it;
 * an installed app's window may, and Insert (`BARE_ACTIONS`) is there for the
 * rest.
 */
const PRIMARY_SHIFT_ACTIONS: Readonly<Record<string, EditAction>> = {
	z: 'redo',
	n: 'newLayer',
	'=': 'zoomIn',
	'+': 'zoomIn',
};

/**
 * With no modifier at all, Shift included: Insert, Krita's key for a new
 * layer, which a tab does hear, where Shift and Insert is paste on Windows and
 * Linux.
 */
const BARE_ACTIONS: Readonly<Record<string, EditAction>> = {
	Insert: 'newLayer',
};

/** With no primary key; Shift reads the same as none, as Caps Lock does. */
const PLAIN_ACTIONS: Readonly<Record<string, EditAction>> = {
	Delete: 'delete',
	Backspace: 'delete',
	']': 'sizeUp',
	'[': 'sizeDown',
	x: 'swapColours',
};

/**
 * The editing action a key asks for: with the primary key, ⌘ on a Mac and
 * Ctrl elsewhere, the ones users know from every editor; without one, the
 * bare keys. None while typing in a field, where Backspace deletes a letter,
 * except Escape, which always means stop.
 */
export const editActionFor = (event: KeyLike, isMac: boolean): EditAction | undefined => {
	if (event.key === 'Escape') return 'escape';
	if (isTyping(event.target) || event.altKey) return undefined;
	const primary = isMac ? event.metaKey : event.ctrlKey;
	if (primary) return (event.shiftKey ? PRIMARY_SHIFT_ACTIONS : PRIMARY_ACTIONS)[keyOf(event)];
	// The other platform's primary key is not a bare key either.
	if (event.ctrlKey || event.metaKey) return undefined;
	return (event.shiftKey ? undefined : BARE_ACTIONS[event.key]) ?? PLAIN_ACTIONS[keyOf(event)];
};

/** The letter shown beside a tool's name. */
export const shortcutLabel = (id: ToolId): string => TOOL_KEYS[id];

/** The primary key's name beside an editing action: the glyph on a Mac's keyboard, the word on others'. */
export const primaryKeyLabel = (isMac: boolean): string => (isMac ? '⌘' : 'Ctrl');
