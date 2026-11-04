import { ColorField } from '../../components/ui/ColorField.js';
import { IconButton } from '../../components/ui/IconButton.js';
import { SwapIcon } from '../../components/ui/icons.js';
import { Panel } from '../../components/ui/Panel.js';
import { t } from '../../i18n/t.js';
import type { ColourSlot } from '../editorState.js';
import type { ToolOptions } from '../tools/types.js';

/**
 * The two colours every tool draws with (docs/ARCHITECTURE.md §7, "The
 * interface"): the fill and the stroke, either of which may be none, the swap
 * X also does, and the colours picked lately as swatches under each field.
 */
export const ColourPanel = ({
	options,
	recent,
	onColour,
	onSwap,
	onClose,
}: Readonly<{
	options: ToolOptions;
	recent: readonly string[];
	onColour: (which: ColourSlot, value: string) => void;
	onSwap: () => void;
	onClose?: () => void;
}>) => (
	<Panel
		title={t('editor.colour.title')}
		onClose={onClose}
		className="colour-panel"
		actions={
			<IconButton icon={<SwapIcon />} label={t('editor.colour.swap')} onClick={onSwap} />
		}
	>
		<ColorField
			label={t('editor.colour.fill')}
			value={options.fill}
			onChange={(value) => onColour('fill', value)}
			allowNone
			recent={recent}
		/>
		<ColorField
			label={t('editor.colour.stroke')}
			value={options.stroke}
			onChange={(value) => onColour('stroke', value)}
			allowNone
			recent={recent}
		/>
	</Panel>
);
