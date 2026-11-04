import { ColorField } from '../../components/ui/ColorField.js';
import { CheckIcon } from '../../components/ui/icons.js';
import { Slider } from '../../components/ui/Slider.js';
import { ToolBar } from '../../components/ui/ToolBar.js';
import { ToolButton } from '../../components/ui/ToolButton.js';
import { t } from '../../i18n/t.js';
import { SIZE_MAX, SIZE_MIN } from '../editorState.js';
import type { Tool, ToolOptionKey, ToolOptions } from '../tools/types.js';

/**
 * One row of options for the tool in hand (docs/ARCHITECTURE.md §7, "The
 * interface"): the keys the tool names, in its order, each as the control its
 * kind takes. The bar is there even for a tool with no options, so the canvas
 * does not jump when the tool changes.
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
type FractionKey = 'opacity' | 'hardness' | 'smoothing' | 'tolerance' | 'strength';
type ToggleKey = 'pressure' | 'constrain';

const isLength = (key: ToolOptionKey): key is LengthKey => key in LENGTHS;
const isFraction = (key: ToolOptionKey): key is FractionKey =>
	key === 'opacity' ||
	key === 'hardness' ||
	key === 'smoothing' ||
	key === 'tolerance' ||
	key === 'strength';
const isToggle = (key: ToolOptionKey): key is ToggleKey =>
	key === 'pressure' || key === 'constrain';

/** A shape's fill may be none, as its stroke may; a brush's fill is the paint itself. */
const fillMayBeNone = (tool: Tool): boolean =>
	tool.id === 'rectangle' || tool.id === 'ellipse' || tool.id === 'pen';

const Option = ({
	tool,
	option,
	options,
	onChange,
}: Readonly<{
	tool: Tool;
	option: ToolOptionKey;
	options: ToolOptions;
	onChange: OnOptionChange;
}>) => {
	const label = t(`tools.options.${option}`);
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
			<ToolButton
				icon={<CheckIcon />}
				label={label}
				pressed={options[option]}
				onClick={() => onChange(option, !options[option])}
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

export const OptionsStrip = ({
	tool,
	options,
	onChange,
}: Readonly<{
	tool: Tool;
	options: ToolOptions;
	onChange: OnOptionChange;
}>) => (
	<ToolBar orientation="horizontal" label={t('editor.panes.options')} className="options-strip">
		{tool.options.map((option) => (
			<Option
				key={option}
				tool={tool}
				option={option}
				options={options}
				onChange={onChange}
			/>
		))}
	</ToolBar>
);
