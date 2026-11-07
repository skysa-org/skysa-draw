import { type Ref, useId } from 'react';

import { t } from '../../i18n/t.js';
import { classes } from './classes.js';
import { isNone, toHex } from './color.js';
import { ToolButton } from './ToolButton.js';

/**
 * The two colors in the tool bar (docs/ARCHITECTURE.md §7, "The interface"),
 * as Photoshop's tool bar shows its foreground and background: the fill in
 * front at the top left, the stroke behind it at the bottom right, as one
 * tool button that opens the color panel beside it and, pressed again,
 * closes it. The
 * swap and the reset Photoshop keeps beside them are the panel's, and X's
 * and D's, so the bar spends one target on the pair.
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
 * Two colors as one mark, the fill in front of the stroke, sized by where it
 * is drawn (`ui.css`): the pair's face in the tool bar, and the color panel's
 * reset, drawn in the colors it puts back, as Photoshop's is. Decoration: the
 * control it is in has the name.
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

type ColorPairProps = Readonly<{
	fill: string;
	stroke: string;
	/** The color panel, which the pair opens beside it and closes: its id, and whether it is open. */
	panel: Readonly<{ id: string; open: boolean }>;
	onToggle: () => void;
	/** The pair's button, which the color panel is placed beside (`Popover`). */
	ref?: Ref<HTMLButtonElement>;
}>;

/**
 * The pair as one tool button, its face the two colors, named for the pair
 * and described by what each color is now, which a screen reader says after
 * the name, and saying whether the panel it opens is open.
 */
export const ColorPair = ({ fill, stroke, panel, onToggle, ref }: ColorPairProps) => {
	const id = useId();
	return (
		<span className="color-pair">
			<ToolButton
				ref={ref}
				icon={<ColorPairMark fill={fill} stroke={stroke} />}
				label={t('colorPair.title')}
				describedBy={`${id}-fill ${id}-stroke`}
				opens={panel}
				onClick={onToggle}
			/>
			<span id={`${id}-fill`} hidden>
				{NAMES.fill(fill)}
			</span>
			<span id={`${id}-stroke`} hidden>
				{NAMES.stroke(stroke)}
			</span>
		</span>
	);
};
