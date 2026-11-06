import { NumberField } from '../../components/ui/NumberField.js';
import { t } from '../../i18n/t.js';
import type { Size } from '../document/canvasOps.js';

/**
 * What Image size… and Canvas size… share (`ImageSizeDialog.tsx`,
 * `CanvasSizeDialog.tsx`): the canvas's size said in a line, and a width and
 * a height in pixels, as typed, with what a field's text is worth and
 * whether it is a side the canvas may have.
 */

/** The fewest and the most pixels a side of the canvas may have; the most is Photoshop's. */
export const SIDE = { min: 1, max: 300_000 } as const;

/** What the two fields hold, as typed. */
export type SizeText = Readonly<{ width: string; height: string }>;

export type Side = keyof SizeText;

/** Whether each field is one to say is not valid. */
export type SizeValidity = Readonly<Record<Side, boolean>>;

export const otherSide = (side: Side): Side => (side === 'width' ? 'height' : 'width');

/** A number to three places, the canvas's own (`crop.ts`), with no float noise and no -0. */
const clean = (n: number): number => Number(n.toFixed(3)) + 0;

/** A number as a field shows it. */
export const fieldText = (n: number): string => String(clean(n));

/** What a field's text is worth; none where it is empty or not a number. */
export const numberIn = (text: string): number | undefined => {
	const trimmed = text.trim();
	const value = Number(trimmed);
	return trimmed === '' || !Number.isFinite(value) ? undefined : value;
};

/** Whether `n` is a side the canvas may have. */
export const isSide = (n: number | undefined): n is number =>
	n !== undefined && n >= SIDE.min && n <= SIDE.max;

/** A size as the two fields show it. */
export const sizeText = (size: Size): SizeText => ({
	width: fieldText(size.width),
	height: fieldText(size.height),
});

/** A size said in a line: the canvas's now, or the one the fields make. */
export const SizeLine = ({ words, size }: Readonly<{ words: 'current' | 'next'; size: Size }>) => (
	<p className="image-size-line">
		{t(`image.fields.${words}`, { width: clean(size.width), height: clean(size.height) })}
	</p>
);

/**
 * The width and the height, in pixels. `signed` where the fields say how
 * much to add or take away, which a side's own limits do not bound.
 */
export const SizeFields = ({
	text,
	invalid,
	onChange,
	signed = false,
}: Readonly<{
	text: SizeText;
	invalid: SizeValidity;
	onChange: (side: Side, text: string) => void;
	signed?: boolean;
}>) => {
	const limits = signed ? {} : SIDE;
	return (
		<div className="field-group">
			<NumberField
				label={t('image.fields.width')}
				unit={t('image.fields.px')}
				value={text.width}
				invalid={invalid.width}
				signed={signed}
				{...limits}
				onChange={(value) => onChange('width', value)}
			/>
			<NumberField
				label={t('image.fields.height')}
				unit={t('image.fields.px')}
				value={text.height}
				invalid={invalid.height}
				signed={signed}
				{...limits}
				onChange={(value) => onChange('height', value)}
			/>
		</div>
	);
};
