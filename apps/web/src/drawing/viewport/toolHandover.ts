import { useEffect, useEffectEvent, useRef } from 'react';

import type { Handover, ToolBehavior, ToolContext, ToolId, ToolOptions } from '../tools/types.js';

/**
 * The tool in hand, between strokes (docs/ARCHITECTURE.md §7, "Tools"): a
 * tool asking for another (`ToolContext.useTool`), which the select tool's
 * double press does, and the options changing under the tool in hand
 * (`ToolBehavior.optionsChanged`). The frame holds which tool is in hand, so
 * a tool asking for another asks the frame, and the tool bar shows the new
 * one; once the viewport has it in hand, with the one before put down, the
 * new tool is given what it was asked for with (`ToolBehavior.edit`).
 */

/** The behavior in hand on the active layer, and a context for it, as they are now. */
type InHand = Readonly<{ behavior: ToolBehavior; context: ToolContext }>;

/** A tool asked for, and what it is to edit once it is in hand. */
type Request = Readonly<{ id: ToolId; handover: Handover | undefined }>;

type Deps = Readonly<{
	toolId: ToolId;
	options: ToolOptions;
	/** The frame's way of putting a tool in hand; none for a viewport with no frame to ask. */
	onTool: ((id: ToolId) => void) | undefined;
	/** The tool in hand now: none where it does nothing on the active layer, or before the canvas is there. */
	inHand: () => InHand | undefined;
	/** The tool in hand was given a context outside a stroke, which it is told it is put down with. */
	keep: (inHand: InHand) => void;
}>;

export type ToolHandover = Readonly<{
	/** `ToolContext.useTool`; none without a frame to ask. */
	useTool: ToolContext['useTool'];
	/**
	 * The tool changed, and the one before was put down: the one now in hand
	 * is given what it was asked for with, if it was. For the viewport's own
	 * effect for a change of tool, after it put the last one down.
	 */
	arrived: () => void;
	/** A press began: a tool asked for that the frame never put in hand is no longer wanted. */
	forget: () => void;
}>;

export const useToolHandover = ({ toolId, options, onTool, inHand, keep }: Deps): ToolHandover => {
	const requested = useRef<Request | undefined>(undefined);

	const hand = (asked: Request): void => {
		const now = inHand();
		if (now === undefined) return;
		keep(now);
		if (asked.handover !== undefined) now.behavior.edit?.(now.context, asked.handover);
	};

	// New options for the tool in hand; the first render's are not new.
	const told = useRef(options);
	const tell = useEffectEvent(() => {
		const now = inHand();
		now?.behavior.optionsChanged?.(now.context);
	});
	useEffect(() => {
		if (told.current === options) return;
		told.current = options;
		tell();
	}, [options]);

	return {
		useTool:
			onTool === undefined
				? undefined
				: (id, handover) => {
						const asked = { id, handover };
						if (id === toolId) {
							hand(asked);
							return;
						}
						requested.current = asked;
						onTool(id);
					},
		arrived: () => {
			const asked = requested.current;
			requested.current = undefined;
			if (asked?.id === toolId) hand(asked);
		},
		forget: () => {
			requested.current = undefined;
		},
	};
};
