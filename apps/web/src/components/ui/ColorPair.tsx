import { type ReactNode, useId } from 'react';

import { t } from '../../i18n/t.js';
import { classes } from './classes.js';
import { isNone, toHex } from './color.js';
import { SwapIcon } from './icons.js';

/**
 * The two colors at the foot of the tool bar (docs/ARCHITECTURE.md §7, "The
 * interface"), as Photoshop's tool bar shows its foreground and background:
 * the fill in front at the top left, the stroke behind it at the bottom
 * right, and a swap. The reset Photoshop keeps beside them is the color
 * panel's and D's, so the bar spends no target on what is seldom pressed.
 *
 * Every press is a target of its own in either direction
 * (docs/decisions/0004-the-interface.md), which Photoshop's corner glyphs are
 * not, so the pair runs along its bar a target per control, whichever way
 * the bar runs (`ui.css`): the fill, the stroke, the swap. The squares are
 * drawn across the fill's and the stroke's targets and take no press
 * themselves, so each target is its whole cell; the pointer over one rings
 * its square, not the cell, which the square is drawn across. Where the bar
 * is short of room, `compact` makes it two: both colors in one control, and
 * the swap.
 */

type Slot = 'fill' | 'stroke';

/** A color as a name says it: `#rrggbb` where it has that form, as written where it does not. */
const shown = (color: string): string => toHex(color) ?? color.trim();

/** Each color's control's name, a whole sentence whether or not there is a color. */
const NAMES: Readonly<Record<Slot, (color: string) => string>> = {
	fill: (color) =>
		isNone(color) ? t('colorPair.fillNone') : t('colorPair.fill', { color: shown(color) }),
	stroke: (color) =>
		isNone(color) ? t('colorPair.strokeNone') : t('colorPair.stroke', { color: shown(color) }),
};

/** The label and its key, as a tool's tooltip has them. */
const withShortcut = (label: string, shortcut: string | undefined): string =>
	shortcut === undefined ? label : t('ui.labelWithShortcut', { label, shortcut });

/** A color as a square, drawn in `currentColor` (`ui.css`); none is struck through. */
const Square = ({ color, className }: Readonly<{ color: string; className?: string }>) => (
	<span
		className={classes('color-pair-square', isNone(color) && 'is-none', className)}
		// The color is the one style set here.
		style={isNone(color) ? undefined : { color }}
		aria-hidden="true"
	/>
);

/**
 * Two colors as one mark, the fill in front of the stroke, sized by its
 * class: the compact pair's face, and the color panel's reset, drawn in the
 * colors it puts back, as Photoshop's is. Decoration: the control it is in
 * has the name.
 */
export const ColorPairMark = ({
	fill,
	stroke,
	className,
}: Readonly<{ fill: string; stroke: string; className?: string }>) => (
	<span className={classes('color-pair-mark', className)} aria-hidden="true">
		<Square color={stroke} className="color-pair-mark-stroke" />
		<Square color={fill} className="color-pair-mark-fill" />
	</span>
);

/** A control of the pair: a target either way, named, its key in its tooltip as a tool's is. */
const PairButton = ({
	label,
	shortcut,
	pressed,
	describedBy,
	className,
	onClick,
	children,
}: Readonly<{
	label: string;
	shortcut?: string;
	pressed?: boolean;
	describedBy?: string;
	className: string;
	onClick: () => void;
	children: ReactNode;
}>) => (
	<button
		type="button"
		className={classes('icon-button', className)}
		aria-label={label}
		aria-describedby={describedBy}
		aria-pressed={pressed}
		title={withShortcut(label, shortcut)}
		onClick={onClick}
	>
		{children}
	</button>
);

type ColorPairProps = Readonly<{
	fill: string;
	stroke: string;
	/** The color the color panel is open on, while it is open. */
	editing: Slot | undefined;
	/** Both colors in one control, and the swap: for a bar short of room. */
	compact?: boolean;
	swapShortcut?: string;
	/** A color's control pressed: the color panel, on that color. */
	onEdit: (slot: Slot) => void;
	onSwap: () => void;
}>;

/** The compact pair: one control that shows both and opens on the fill, and the swap. */
const CompactPair = ({
	fill,
	stroke,
	editing,
	swap,
	onEdit,
}: Pick<ColorPairProps, 'fill' | 'stroke' | 'editing' | 'onEdit'> &
	Readonly<{ swap: ReactNode }>) => {
	const id = useId();
	return (
		<div className="color-pair color-pair-compact">
			<PairButton
				label={t('colorPair.title')}
				describedBy={`${id}-fill ${id}-stroke`}
				pressed={editing !== undefined}
				className="color-pair-both"
				onClick={() => onEdit('fill')}
			>
				<ColorPairMark fill={fill} stroke={stroke} />
			</PairButton>
			{/* What the one control holds, said after its name. */}
			<span id={`${id}-fill`} hidden>
				{NAMES.fill(fill)}
			</span>
			<span id={`${id}-stroke`} hidden>
				{NAMES.stroke(stroke)}
			</span>
			{swap}
		</div>
	);
};

export const ColorPair = ({
	fill,
	stroke,
	editing,
	compact,
	swapShortcut,
	onEdit,
	onSwap,
}: ColorPairProps) => {
	const swap = (
		<PairButton
			label={t('colorPair.swap')}
			shortcut={swapShortcut}
			className="color-pair-swap"
			onClick={onSwap}
		>
			<SwapIcon />
		</PairButton>
	);
	if (compact === true) {
		return (
			<CompactPair
				fill={fill}
				stroke={stroke}
				editing={editing}
				swap={swap}
				onEdit={onEdit}
			/>
		);
	}
	return (
		<div className="color-pair" role="group" aria-label={t('colorPair.title')}>
			<PairButton
				label={NAMES.fill(fill)}
				pressed={editing === 'fill'}
				className="color-pair-slot color-pair-fill"
				onClick={() => onEdit('fill')}
			>
				<Square color={fill} />
			</PairButton>
			<PairButton
				label={NAMES.stroke(stroke)}
				pressed={editing === 'stroke'}
				className="color-pair-slot color-pair-stroke"
				onClick={() => onEdit('stroke')}
			>
				<Square color={stroke} />
			</PairButton>
			{swap}
		</div>
	);
};
