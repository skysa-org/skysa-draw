import type { Dispatch } from 'react';

import { ColorPair } from '../../components/ui/ColorPair.js';
import { ICONS, LayersIcon } from '../../components/ui/icons.js';
import { ToolButton } from '../../components/ui/ToolButton.js';
import { t } from '../../i18n/t.js';
import type { ColorSlot, EditorAction } from '../editorState.js';
import { shortcutFor, shortcutLabel } from '../keys.js';
import { TOOLS } from '../tools/index.js';
import type { Tool } from '../tools/types.js';
import { isMac } from '../viewport/pointer.js';

/**
 * What the tool bar and the rail hold (docs/ARCHITECTURE.md §7, "The
 * interface"): a button per tool, then the two colors and their swap, and the
 * layers. The reset is the color panel's. The frame (`Editor.tsx`) places
 * the bar; this is what is in it.
 */

const MAC = isMac();

type ToolButtonsProps = Readonly<{
	tool: Tool;
	fill: string;
	stroke: string;
	/** The color the color panel is open on, while it is open. */
	editing: ColorSlot | undefined;
	/** The bar is short of room, as a compact window's is: the colors as one control and the swap. */
	compact: boolean;
	layersOpen: boolean;
	dispatch: Dispatch<EditorAction>;
	onLayers: () => void;
}>;

/**
 * The tools, then the colors and the layers, which stay at the bar's far end
 * while the tools scroll past them on a narrow bar (`editor.css`). The colors
 * are where the tool's options are set (`data-tool-options`,
 * `tools/optionsRegion.ts`), as the color panel they open is: a color picked
 * or swapped there while the text tool's field is open is the text's.
 */
export const ToolButtons = ({
	tool,
	fill,
	stroke,
	editing,
	compact,
	layersOpen,
	dispatch,
	onLayers,
}: ToolButtonsProps) => (
	<>
		{TOOLS.map((each) => {
			const Icon = ICONS[each.id];
			return (
				<ToolButton
					key={each.id}
					icon={<Icon />}
					label={t(`tools.${each.id}`)}
					shortcut={shortcutLabel(each.id)}
					pressed={each.id === tool.id}
					onClick={() => dispatch({ type: 'setTool', toolId: each.id })}
				/>
			);
		})}
		<span className="tool-group-end">
			<span className="tool-options" data-tool-options="">
				<ColorPair
					fill={fill}
					stroke={stroke}
					editing={editing}
					compact={compact}
					swapShortcut={shortcutFor('swapColors', MAC)}
					onEdit={(which) => dispatch({ type: 'editColor', which })}
					onSwap={() => dispatch({ type: 'swapColors' })}
				/>
			</span>
			<ToolButton
				icon={<LayersIcon />}
				label={t('layers.title')}
				pressed={layersOpen}
				onClick={onLayers}
			/>
		</span>
	</>
);
