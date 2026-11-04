import { useEffect, useRef } from 'react';

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
 * interface"): the fill and the stroke, either of which may be none, the swap
 * X also does, the reset D does, and the colors picked lately as swatches
 * under each field. The reset is here and not in the tool bar's pair, which
 * keeps its targets for what is pressed often. Opened on one of the two from
 * the tool bar's pair, that one is marked and has the focus.
 * Where the tool's options are set (`data-tool-options`,
 * `tools/optionsRegion.ts`), as the options strip is: a color picked here
 * while the text tool's field is open is the text's.
 */
export const ColorPanel = ({
	options,
	recent,
	editing,
	onColor,
	onSwap,
	onReset,
	onClose,
}: Readonly<{
	options: ToolOptions;
	recent: readonly string[];
	/** The color the panel was opened on: marked, and given the focus. */
	editing?: ColorSlot;
	onColor: (which: ColorSlot, value: string) => void;
	onSwap: () => void;
	/** The fill and the stroke put back, which the tool bar has no control for. */
	onReset: () => void;
	onClose?: () => void;
}>) => {
	const fields = useRef<HTMLDivElement>(null);
	// The picker of the color asked for takes the focus once the sheet or the
	// drawer has taken it as it opens (`PanelHost`, whose effect runs after
	// this one), so what opened the panel is still where the focus goes back.
	useEffect(() => {
		if (editing === undefined) return;
		queueMicrotask(() => {
			fields.current
				?.querySelector<HTMLInputElement>(`[data-slot="${editing}"] input[type="color"]`)
				?.focus();
		});
	}, [editing]);
	const field = (which: ColorSlot, label: string) => (
		<div
			className="color-panel-slot"
			data-slot={which}
			data-editing={editing === which ? '' : undefined}
		>
			<ColorField
				label={label}
				value={options[which]}
				onChange={(value) => onColor(which, value)}
				allowNone
				recent={recent}
			/>
		</div>
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
				<div ref={fields}>
					{field('fill', t('editor.color.fill'))}
					{field('stroke', t('editor.color.stroke'))}
				</div>
			</Panel>
		</div>
	);
};
