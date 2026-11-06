import '../../styles/imageDialogs.css';

import { type KeyboardEvent, useId } from 'react';

import { t } from '../../i18n/t.js';
import type { Anchor } from '../document/canvasOps.js';

/**
 * Canvas size's anchor (docs/decisions/0004-the-interface.md): Photoshop's
 * nine squares, which say where the drawing stays as the canvas grows or
 * shrinks around it. The anchor's square is filled, and each of the eight
 * around it shows an arrow pointing away from it, the way the canvas grows
 * there, as Photoshop draws them; a square further off is empty. A radio group: the arrow keys move the choice from square to
 * square as on the canvas, a row or a column at a time, stopping at the
 * edges, Home and End go to the first and the last, Space chooses the one
 * the focus is on, and the group is one stop for Tab, at the anchor. It is a
 * picture of the canvas, so its left is the canvas's whatever the page's
 * direction (`imageDialogs.css`).
 */

/** In reading order, the rows from the top: the grid's squares. */
export const ANCHORS: readonly Anchor[] = [
	'topLeft',
	'top',
	'topRight',
	'left',
	'center',
	'right',
	'bottomLeft',
	'bottom',
	'bottomRight',
];

/** A square's row and column, from the top left. */
type Square = Readonly<{ row: number; column: number }>;

const squareOf = (anchor: Anchor): Square => {
	const index = ANCHORS.indexOf(anchor);
	return { row: Math.floor(index / 3), column: index % 3 };
};

const toEdge = (n: number): number => Math.min(2, Math.max(0, n));

const STEPS: Readonly<Partial<Record<string, Square>>> = {
	ArrowUp: { row: -1, column: 0 },
	ArrowDown: { row: 1, column: 0 },
	ArrowLeft: { row: 0, column: -1 },
	ArrowRight: { row: 0, column: 1 },
};

/** Where `key` moves the choice from `anchor`; none for a key that is not the group's. */
export const anchorAfter = (anchor: Anchor, key: string): Anchor | undefined => {
	if (key === 'Home') return ANCHORS[0];
	if (key === 'End') return ANCHORS[ANCHORS.length - 1];
	const step = STEPS[key];
	if (step === undefined) return undefined;
	const at = squareOf(anchor);
	return ANCHORS[toEdge(at.row + step.row) * 3 + toEdge(at.column + step.column)];
};

/** What a square shows: the anchor, an arrow away from it, or nothing. */
const Mark = ({ square, anchor }: Readonly<{ square: Square; anchor: Square }>) => {
	const down = square.row - anchor.row;
	const across = square.column - anchor.column;
	if (Math.abs(down) > 1 || Math.abs(across) > 1) return null;
	const angle = (Math.atan2(down, across) * 180) / Math.PI;
	return (
		<svg
			viewBox="0 0 24 24"
			width={20}
			height={20}
			fill="none"
			stroke="currentColor"
			strokeWidth={1.75}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			{down === 0 && across === 0 ? (
				<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
			) : (
				<path d="M5 12h13M13 7l5 5-5 5" transform={`rotate(${String(angle)} 12 12)`} />
			)}
		</svg>
	);
};

export const AnchorGrid = ({
	value,
	onChange,
}: Readonly<{ value: Anchor; onChange: (anchor: Anchor) => void }>) => {
	const labelId = useId();
	const anchor = squareOf(value);
	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		const next = anchorAfter(value, event.key);
		if (next === undefined) return;
		// The page does not scroll, and a tool's arrows do not nudge what is selected.
		event.preventDefault();
		onChange(next);
		event.currentTarget.parentElement
			?.querySelector<HTMLElement>(`[data-anchor="${next}"]`)
			?.focus();
	};
	return (
		<div className="field-group">
			<span className="field-legend" id={labelId}>
				{t('image.canvasDialog.anchor')}
			</span>
			<div role="radiogroup" aria-labelledby={labelId} className="anchor-grid">
				{ANCHORS.map((each) => (
					<button
						key={each}
						type="button"
						role="radio"
						aria-checked={each === value}
						aria-label={t(`image.canvasDialog.anchors.${each}`)}
						tabIndex={each === value ? 0 : -1}
						data-anchor={each}
						className="anchor-square"
						onClick={() => onChange(each)}
						onKeyDown={onKeyDown}
					>
						<Mark square={squareOf(each)} anchor={anchor} />
					</button>
				))}
			</div>
		</div>
	);
};
