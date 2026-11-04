import { IconButton } from '../../components/ui/IconButton.js';
import { AddIcon, ChevronDownIcon, ChevronUpIcon, DeleteIcon } from '../../components/ui/icons.js';
import { Menu } from '../../components/ui/Menu.js';
import { t } from '../../i18n/t.js';
import {
	type Adjustment,
	ADJUSTMENT_KINDS,
	ADJUSTMENT_PARAMETERS,
	type AdjustmentKind,
	type AdjustmentParameter,
	newAdjustment,
	parameterValue,
	setAdjustments,
} from '../document/adjustments.js';
import type { EditorDocument, LayerInfo } from '../document/model.js';
import { LiveSlider } from './LiveSlider.js';
import { type Preview, usePreview } from './usePreview.js';

/**
 * The layer's adjustments (docs/decisions/0003-layers.md: SVG's own filters
 * on the layer, so they stay editable): added from a menu, each with a slider
 * per parameter, moved up and down the stack and removed. A drag shows the
 * change live and the release makes it, one step to undo (`LiveSlider`,
 * `usePreview`). A filter another tool made is named as such and left alone.
 */

const KIND_NAMES: Readonly<Record<AdjustmentKind, () => string>> = {
	brightness: () => t('layers.adjustments.kinds.brightness'),
	contrast: () => t('layers.adjustments.kinds.contrast'),
	hue: () => t('layers.adjustments.kinds.hue'),
	saturation: () => t('layers.adjustments.kinds.saturation'),
	blur: () => t('layers.adjustments.kinds.blur'),
	invert: () => t('layers.adjustments.kinds.invert'),
	grayscale: () => t('layers.adjustments.kinds.grayscale'),
	shadow: () => t('layers.adjustments.kinds.shadow'),
};

/** A drop shadow's parameters by their own names; every other adjustment has one, named as it is. */
const SHADOW_NAMES: Readonly<Partial<Record<AdjustmentParameter['name'], () => string>>> = {
	dx: () => t('layers.adjustments.shadow.dx'),
	dy: () => t('layers.adjustments.shadow.dy'),
	blur: () => t('layers.adjustments.shadow.blur'),
	opacity: () => t('layers.adjustments.shadow.opacity'),
};

const parameterLabel = (kind: AdjustmentKind, parameter: AdjustmentParameter): string =>
	(kind === 'shadow' ? SHADOW_NAMES[parameter.name] : undefined)?.() ?? KIND_NAMES[kind]();

const FORMATS: Readonly<Record<AdjustmentParameter['unit'], (n: number) => string>> = {
	percent: (n) => t('editor.units.percent', { n }),
	degrees: (n) => t('editor.units.degrees', { n }),
	units: (n) => t('editor.units.px', { n }),
};

/** The list with the adjustment at `index` given `value` for `parameter`. */
const withValue = (
	list: readonly Adjustment[],
	index: number,
	parameter: AdjustmentParameter,
	value: number
): readonly Adjustment[] =>
	list.map((adjustment, at) =>
		at === index
			? { ...adjustment, values: { ...adjustment.values, [parameter.name]: value } }
			: adjustment
	);

/** The list with the adjustment at `index` traded with its neighbour `by` away. */
const moved = (list: readonly Adjustment[], index: number, by: number): readonly Adjustment[] => {
	const other = index + by;
	const one = list[index];
	const two = list[other];
	if (one === undefined || two === undefined) return list;
	return list.map((adjustment, at) => {
		if (at === index) return two;
		return at === other ? one : adjustment;
	});
};

const AdjustmentItem = ({
	adjustment,
	index,
	count,
	preview,
	onPreview,
	onSet,
}: Readonly<{
	adjustment: Adjustment;
	index: number;
	count: number;
	preview: Preview;
	onPreview: (list: (current: readonly Adjustment[]) => readonly Adjustment[]) => void;
	onSet: (list: (current: readonly Adjustment[]) => readonly Adjustment[], label: string) => void;
}>) => {
	const name = KIND_NAMES[adjustment.kind]();
	return (
		<li className="adjustment">
			<div className="adjustment-header">
				<span className="adjustment-name">{name}</span>
				<IconButton
					icon={<ChevronUpIcon />}
					label={t('layers.adjustments.moveUp', { name })}
					disabled={index === 0}
					onClick={() =>
						onSet((list) => moved(list, index, -1), 'layers.adjustments.reorder')
					}
				/>
				<IconButton
					icon={<ChevronDownIcon />}
					label={t('layers.adjustments.moveDown', { name })}
					disabled={index === count - 1}
					onClick={() =>
						onSet((list) => moved(list, index, 1), 'layers.adjustments.reorder')
					}
				/>
				<IconButton
					icon={<DeleteIcon />}
					label={t('layers.adjustments.remove', { name })}
					onClick={() =>
						onSet(
							(list) => list.filter((_, at) => at !== index),
							'layers.adjustments.removed'
						)
					}
				/>
			</div>
			{ADJUSTMENT_PARAMETERS[adjustment.kind].map((parameter) => {
				const value = parameterValue(adjustment, parameter);
				return (
					<LiveSlider
						key={parameter.name}
						label={parameterLabel(adjustment.kind, parameter)}
						value={value}
						min={parameter.min}
						max={parameter.max}
						step={parameter.step}
						format={FORMATS[parameter.unit]}
						onPreview={(next) =>
							onPreview((list) => withValue(list, index, parameter, next))
						}
						onCommit={(next) => {
							preview.restore();
							if (next !== value) {
								onSet(
									(list) => withValue(list, index, parameter, next),
									'layers.adjustments.change'
								);
							}
						}}
					/>
				);
			})}
		</li>
	);
};

export const AdjustmentsPanel = ({
	document,
	layer,
}: Readonly<{ document: EditorDocument; layer: LayerInfo }>) => {
	const preview = usePreview(document);
	const state = layer.adjustments;
	const title = t('layers.adjustments.title');
	if (state?.own === false) {
		return (
			<section className="adjustments" aria-label={title}>
				<h3 className="adjustments-title">{title}</h3>
				<p className="adjustments-foreign">{t('layers.adjustments.foreign')}</p>
				<p className="panel-empty">{t('layers.adjustments.foreignNote')}</p>
			</section>
		);
	}
	const list = state?.list ?? [];
	const set = (
		change: (current: readonly Adjustment[]) => readonly Adjustment[],
		label: string
	) => {
		preview.restore();
		document.execute(setAdjustments(document.root, layer.id, change(list), label));
	};
	const show = (change: (current: readonly Adjustment[]) => readonly Adjustment[]) => {
		preview.show(() =>
			setAdjustments(document.root, layer.id, change(list), 'layers.adjustments.change')
		);
	};
	return (
		<section className="adjustments" aria-label={title}>
			<div className="adjustments-header">
				<h3 className="adjustments-title">{title}</h3>
				<Menu
					label={t('layers.adjustments.add')}
					icon={<AddIcon />}
					align="end"
					items={ADJUSTMENT_KINDS.map((kind) => ({
						id: kind,
						label: KIND_NAMES[kind](),
						onSelect: () =>
							set(
								(current) => [...current, newAdjustment(kind)],
								'layers.adjustments.add'
							),
					}))}
				/>
			</div>
			{list.length > 0 && (
				<ol className="adjustment-list">
					{list.map((adjustment, index) => (
						<AdjustmentItem
							// The list is the layer's, rebuilt on every change; an
							// adjustment is where it is in it.

							key={`${String(index)}-${adjustment.kind}`}
							adjustment={adjustment}
							index={index}
							count={list.length}
							preview={preview}
							onPreview={show}
							onSet={set}
						/>
					))}
				</ol>
			)}
		</section>
	);
};
