/** The Remove tool (docs/decisions/0004-the-interface.md): a stroke over what goes, made again from what is around it. */
export const remove = {
	/** A stroke's removal, as the undo history names it. */
	command: 'Remove',
	/** Over the canvas while what a stroke painted over is made again. */
	working: 'Removing what you painted over…',
	/** The button beside it, which Escape does too. */
	stop: 'Stop',
	/** A removal stopped by the user. */
	stopped: 'Remove was stopped, and the layer is as it was.',
	/** A removal stopped by a change to the layer while it ran: an undo, a stroke. */
	changed: 'The layer changed while Remove was working, so nothing was removed.',
	/** A removal that could not be made. */
	failed: 'What you painted over could not be made again from the picture around it, so the layer is as it was.',
	/**
	 * A stroke begun while the pixels of an earlier one, or of a content-aware
	 * fill, are still being made again: it paints nothing.
	 */
	busy: 'The last change is still being made. Wait for it to finish, or stop it, before you paint again.',
} as const;
