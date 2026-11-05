import { Fragment } from 'react';

import { type Choice, ChoiceButtons } from '../../components/ui/ChoiceButtons.js';
import { ColorField } from '../../components/ui/ColorField.js';
import { ICONS } from '../../components/ui/icons.js';
import type { MenuItem } from '../../components/ui/Menu.js';
import { Slider } from '../../components/ui/Slider.js';
import { Toggle } from '../../components/ui/Toggle.js';
import { ToolBar, ToolBarRule } from '../../components/ui/ToolBar.js';
import { t } from '../../i18n/t.js';
import { SIZE_MAX, SIZE_MIN } from '../editorState.js';
import { areaModeKeys, type Held } from '../keys.js';
import type { AreaMode, Tool, ToolOptionKey, ToolOptions } from '../tools/types.js';
import { isMac } from '../viewport/pointer.js';

/**
 * One row of options for the tool in hand (docs/ARCHITECTURE.md §7, "The
 * interface"): the keys the tool names, in its order, each as the control its
 * kind takes: a slider, a color field, a toggle with its name beside its
 * check box, or, for the selection tools' mode, a button for each mode, by
 * its icon, as Photoshop's options bar has them. The bar is there even for a
 * tool with no options, so the canvas does not jump when the tool changes.
 *
 * After them, while something is selected and the tool is one that selects,
 * the selection bar (docs/decisions/0004-the-interface.md, "The context
 * menu"): the context menu's actions as buttons, which a touch screen has no
 * other way to, as Procreate's selection bar is. They follow the tool's own
 * options rather than take their place, since the marquee's are still wanted
 * for the next area, and the row scrolls sideways where it is too narrow for
 * both, as the tool bar does.
 *
 * It is where the tool's options are set (`data-tool-options`,
 * `tools/optionsRegion.ts`): the focus coming here leaves open what the tool
 * has open, the text tool's field, so that a size or a color chosen while
 * typing is the text's.
 */

type OnOptionChange = <K extends ToolOptionKey>(key: K, value: ToolOptions[K]) => void;

const px = (n: number): string => t('editor.units.px', { n });
const percent = (n: number): string => t('editor.units.percent', { n: Math.round(n * 100) });

/** The sliders in user units: the range each runs over; a size's is the one `[` and `]` keep to. */
const LENGTHS = {
	size: [SIZE_MIN, SIZE_MAX],
	strokeWidth: [0, 50],
	cornerRadius: [0, 100],
	fontSize: [6, 400],
} as const;

type LengthKey = keyof typeof LENGTHS;
type FractionKey =
	'opacity' | 'hardness' | 'smoothing' | 'tolerance' | 'strength' | 'pupilSize' | 'darken';
type ToggleKey = 'pressure' | 'constrain' | 'contiguous' | 'autoSelect';

const isLength = (key: ToolOptionKey): key is LengthKey => key in LENGTHS;
const isFraction = (key: ToolOptionKey): key is FractionKey =>
	key === 'opacity' ||
	key === 'hardness' ||
	key === 'smoothing' ||
	key === 'tolerance' ||
	key === 'strength' ||
	key === 'pupilSize' ||
	key === 'darken';
const isToggle = (key: ToolOptionKey): key is ToggleKey =>
	key === 'pressure' || key === 'constrain' || key === 'contiguous' || key === 'autoSelect';

/** The selection tools' modes, in the order of Photoshop's options bar, each by its icon. */
const AREA_MODES: readonly (readonly [AreaMode, keyof typeof ICONS])[] = [
	['new', 'areaNew'],
	['add', 'areaAdd'],
	['subtract', 'areaSubtract'],
	['intersect', 'areaIntersect'],
];

/**
 * Keys held, as each platform writes them in a chord (`keys.ts`): `⌥⇧`, in
 * Apple's order, on a Mac; `Shift+Alt` elsewhere.
 */
const heldLabel = (held: Held, mac: boolean): string =>
	mac
		? `${held.altKey ? '⌥' : ''}${held.shiftKey ? '⇧' : ''}`
		: [held.shiftKey && 'Shift', held.altKey && 'Alt']
				.filter((name) => name !== false)
				.join('+');

/**
 * The mode's buttons, each named in words, with the keys that, held as a
 * drag or a click begins, make it in that mode (`areaModeKeys`) in its
 * tooltip; a new selection has none.
 */
const areaModeChoices = (mac: boolean): readonly Choice<AreaMode>[] =>
	AREA_MODES.map(([mode, icon]) => {
		const Icon = ICONS[icon];
		const held = areaModeKeys(mode);
		return {
			value: mode,
			label: t(`tools.areaModes.${mode}`),
			icon: <Icon />,
			...(held === undefined ? {} : { shortcut: heldLabel(held, mac) }),
		};
	});

/** A shape's fill may be none, as its stroke may; a brush's fill is the paint itself. */
const fillMayBeNone = (tool: Tool): boolean =>
	tool.id === 'rectangle' || tool.id === 'ellipse' || tool.id === 'pen';

const Option = ({
	tool,
	option,
	options,
	onChange,
	mac,
}: Readonly<{
	tool: Tool;
	option: ToolOptionKey;
	options: ToolOptions;
	onChange: OnOptionChange;
	mac: boolean;
}>) => {
	const label = t(`tools.options.${option}`);
	if (option === 'areaMode') {
		return (
			<ChoiceButtons
				label={label}
				choices={areaModeChoices(mac)}
				value={options.areaMode}
				onChange={(mode) => onChange('areaMode', mode)}
			/>
		);
	}
	if (isLength(option)) {
		const [min, max] = LENGTHS[option];
		return (
			<Slider
				label={label}
				value={options[option]}
				min={min}
				max={max}
				step={1}
				format={px}
				onChange={(value) => onChange(option, value)}
			/>
		);
	}
	if (isFraction(option)) {
		return (
			<Slider
				label={label}
				value={options[option]}
				min={0}
				max={1}
				step={0.01}
				format={percent}
				onChange={(value) => onChange(option, value)}
			/>
		);
	}
	if (isToggle(option)) {
		return (
			<Toggle
				label={label}
				pressed={options[option]}
				onChange={(pressed) => onChange(option, pressed)}
			/>
		);
	}
	return (
		<ColorField
			label={label}
			value={options[option]}
			onChange={(value) => onChange(option, value)}
			allowNone={option === 'stroke' || fillMayBeNone(tool)}
		/>
	);
};

/** One of the selection's actions as a button: its name, and its key in the tooltip. */
const ActionButton = ({ item }: Readonly<{ item: MenuItem }>) => (
	<button
		type="button"
		className="options-action"
		disabled={item.disabled}
		title={
			item.shortcut === undefined
				? item.label
				: t('ui.labelWithShortcut', { label: item.label, shortcut: item.shortcut })
		}
		onClick={item.onSelect}
	>
		{item.label}
	</button>
);

/** The selection's actions, in their groups, a rule between each. */
const SelectionBar = ({ actions }: Readonly<{ actions: readonly MenuItem[] }>) => (
	<div role="group" aria-label={t('selection.bar')} className="options-selection">
		{actions.map((item) => (
			<Fragment key={item.id}>
				{item.separatorBefore === true && <ToolBarRule orientation="horizontal" />}
				<ActionButton item={item} />
			</Fragment>
		))}
	</div>
);

/** Whether the keys are written as a Mac's, read once, as the editor reads it. */
const MAC = isMac();

export const OptionsStrip = ({
	tool,
	options,
	onChange,
	actions = [],
	transforming = false,
	mac = MAC,
}: Readonly<{
	tool: Tool;
	options: ToolOptions;
	onChange: OnOptionChange;
	/** The selection's actions, while something is selected; none otherwise. */
	actions?: readonly MenuItem[];
	/**
	 * Whether Transform selection is on, while which the tool in hand does
	 * nothing on the canvas: its options are hidden and the selection's
	 * Apply and Cancel are all there is, as Photoshop's options bar shows the
	 * transform's own.
	 */
	transforming?: boolean;
	/** Whether the keys in a tooltip are a Mac's; the platform's by default. */
	mac?: boolean;
}>) => (
	<div className="tool-options" data-tool-options="">
		<ToolBar
			orientation="horizontal"
			label={t('editor.panes.options')}
			className="options-strip"
		>
			{(transforming ? [] : tool.options).map((option) => (
				<Option
					key={option}
					tool={tool}
					option={option}
					options={options}
					onChange={onChange}
					mac={mac}
				/>
			))}
			{actions.length > 0 && <SelectionBar actions={actions} />}
		</ToolBar>
	</div>
);
