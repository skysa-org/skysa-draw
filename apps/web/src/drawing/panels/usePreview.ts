import { useEffect, useRef } from 'react';

import type { Command, EditorDocument } from '../document/model.js';

/**
 * A change shown while a slider is dragged, and only shown
 * (docs/ARCHITECTURE.md §7, "Commands and history": "a live preview is not a
 * change"): the command applied to the live root without the history, and
 * reverted before the next one, before the real one is executed, and when
 * the panel goes. A command reverts exactly, so a preview leaves nothing
 * behind; the one executed at the release is the one step undo takes back,
 * as a stroke is.
 */
export type Preview = Readonly<{
	/** Reverts what is shown, then shows what `make` gives, made against the root as it is. */
	show: (make: () => Command) => void;
	/** Puts the root back as it was before anything was shown. */
	restore: () => void;
}>;

export const usePreview = (document: EditorDocument): Preview => {
	const shown = useRef<Command | undefined>(undefined);
	const restore = () => {
		shown.current?.revert(document.root);
		shown.current = undefined;
	};
	useEffect(
		() => () => {
			shown.current?.revert(document.root);
			shown.current = undefined;
		},
		[document]
	);
	return {
		show: (make) => {
			restore();
			const command = make();
			command.apply(document.root);
			shown.current = command;
		},
		restore,
	};
};
