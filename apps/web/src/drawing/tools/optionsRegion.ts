/**
 * Where the tool in hand has its options set (docs/decisions/0004-the-interface.md,
 * "Text"): the options strip, the color panel, and the color pair in the
 * tool bar that opens it, each marked `data-tool-options` by the piece itself. What a tool
 * keeps open after its stroke, the text tool's field, stays open while the
 * focus is in one of them, so that an option changed there is a change to
 * what the tool holds, as a font size chosen while typing is in every editor.
 */
const MARK = '[data-tool-options]';

/**
 * Whether `target` is where the options are set: inside a marked region, or
 * a sheet or a drawer that holds one, a dialog that takes the focus itself as
 * it opens (`PanelHost`).
 */
export const inToolOptions = (target: EventTarget | null): boolean =>
	target instanceof Element &&
	(target.closest(MARK) !== null ||
		(target.matches('[role="dialog"]') && target.querySelector(`:scope > ${MARK}`) !== null));
