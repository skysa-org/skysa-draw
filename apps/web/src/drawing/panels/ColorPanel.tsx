import { ColorField } from '../../components/ui/ColorField.js';
import { ColorPairMark } from '../../components/ui/ColorPair.js';
import { IconButton } from '../../components/ui/IconButton.js';
import { SwapIcon } from '../../components/ui/icons.js';
import { Panel } from '../../components/ui/Panel.js';
import { t } from '../../i18n/t.js';
import type { ColorSlot } from '../editorState.js';
import { shortcutFor } from '../keys.js';
import { DEFAULT_TOOL_OPTIONS, type ToolOptions } from '../tools/types.js';
import { isMac } from '../viewport/pointer.js';

const MAC = isMac();

/**
 * The two colors every tool draws with (docs/ARCHITECTURE.md §7, "The
 * interface"), opened and closed by the colors' button in the tool bar: the
 * fill and the stroke, either of which may be none, each a group with its
 * name over it and the colors picked lately under it; and in the header the
 * swap X also does and the reset D does, which the tool bar has no control
 * for. Where the tool's options are set (`data-tool-options`,
 * `tools/optionsRegion.ts`), as the options strip is: a color picked here
 * while the text tool's field is open is the text's.
 */
export const ColorPanel = ({
	options,
	recent,
	onColor,
	onSwap,
	onReset,
	onClose,
}: Readonly<{
	options: ToolOptions;
	recent: readonly string[];
	onColor: (which: ColorSlot, value: string) => void;
	onSwap: () => void;
	/** The fill and the stroke put back. */
	onReset: () => void;
	onClose?: () => void;
}>) => {
	const field = (which: ColorSlot, label: string) => (
		<ColorField
			layout="stacked"
			label={label}
			value={options[which]}
			onChange={(value) => onColor(which, value)}
			allowNone
			recent={recent}
		/>
	);
	return (
		<div className="tool-options" data-tool-options="">
			<Panel
				title={t('editor.color.title')}
				onClose={onClose}
				className="color-panel"
				actions={
					<>
						<IconButton
							icon={<SwapIcon />}
							label={t('editor.color.swap')}
							shortcut={shortcutFor('swapColors', MAC)}
							onClick={onSwap}
						/>
						<IconButton
							icon={
								<ColorPairMark
									fill={DEFAULT_TOOL_OPTIONS.fill}
									stroke={DEFAULT_TOOL_OPTIONS.stroke}
								/>
							}
							label={t('colorPair.reset')}
							shortcut={shortcutFor('resetColors', MAC)}
							onClick={onReset}
						/>
					</>
				}
			>
				<div className="field-groups">
					{field('fill', t('editor.color.fill'))}
					{field('stroke', t('editor.color.stroke'))}
				</div>
			</Panel>
		</div>
	);
};
