import { cell } from '@skysa/draw-core';

import type { Command } from './model.js';

/**
 * Undo and redo for one open drawing (docs/ARCHITECTURE.md §7, "Commands and
 * history"): in memory, as long as the session, capped by what the commands
 * keep rather than by their number, since one raster stroke keeps an encoded
 * layer and one rename keeps a word. The history only orders commands; the
 * document applies and reverts them.
 */

/** What the history may keep, in bytes, before it lets the oldest step go. */
export const HISTORY_BYTES = 256 * 1024 * 1024;

type History = Readonly<{
	/** A command just applied: the newest step; whatever was undone before it is gone. */
	push: (command: Command) => void;
	/** The step to revert, which is now redoable; `undefined` when there is none. */
	undo: () => Command | undefined;
	/** The step to apply again, which is now undoable; `undefined` when there is none. */
	redo: () => Command | undefined;
	canUndo: () => boolean;
	canRedo: () => boolean;
	/**
	 * Every step undone and none ever let go: the document is the one opened.
	 * Once the oldest step has been evicted the opened state cannot be reached
	 * again, and this is false from then on.
	 */
	atOrigin: () => boolean;
}>;

export const createHistory = (limitBytes: number = HISTORY_BYTES): History => {
	/** Oldest first; the last is the one `undo` reverts. */
	const done = cell<readonly Command[]>([]);
	/** The next to redo first. */
	const undone = cell<readonly Command[]>([]);
	/** What `done` keeps, in bytes. What `undone` keeps is let go by the next push. */
	const kept = cell(0);
	const evicted = cell(false);

	/**
	 * The oldest steps let go until what is kept fits, in one pass, and never
	 * the newest: a step bigger than the whole limit is still undoable.
	 */
	const evict = (): void => {
		if (kept.current <= limitBytes) return;
		const dropped = cell(0);
		const firstKept = done.current.findIndex((command) => {
			if (kept.current - dropped.current <= limitBytes) return true;
			dropped.current += command.bytes;
			return false;
		});
		const from = Math.min(
			firstKept === -1 ? done.current.length : firstKept,
			done.current.length - 1
		);
		if (from <= 0) return;
		const gone = done.current.slice(0, from);
		done.current = done.current.slice(from);
		kept.current -= gone.reduce((total, command) => total + command.bytes, 0);
		evicted.current = true;
	};

	return {
		push: (command) => {
			undone.current = [];
			done.current = [...done.current, command];
			kept.current += command.bytes;
			evict();
		},
		undo: () => {
			const command = done.current.at(-1);
			if (command === undefined) return undefined;
			done.current = done.current.slice(0, -1);
			undone.current = [command, ...undone.current];
			kept.current -= command.bytes;
			return command;
		},
		redo: () => {
			const [command, ...rest] = undone.current;
			if (command === undefined) return undefined;
			undone.current = rest;
			done.current = [...done.current, command];
			kept.current += command.bytes;
			return command;
		},
		canUndo: () => done.current.length > 0,
		canRedo: () => undone.current.length > 0,
		atOrigin: () => !evicted.current && done.current.length === 0,
	};
};
