import type { LayerKind } from '@skysa/draw-core';
import type { Dispatch } from 'react';

import { ColorPair } from '../../components/ui/ColorPair.js';
import { LayersIcon } from '../../components/ui/icons.js';
import type { Orientation } from '../../components/ui/ToolBar.js';
import { ToolButton } from '../../components/ui/ToolButton.js';
import { t } from '../../i18n/t.js';
import type { EditorAction } from '../editorState.js';
import type { Tool } from '../tools/types.js';
import { ToolGroups } from './ToolGroups.js';

/**
 * What the tool bar and the rail hold (docs/ARCHITECTURE.md §7, "The
 * interface"): the tools, then the two colors as one button, and the
 * layers. The swap and the reset are the color panel's. The frame
 * (`Editor.tsx`) places the bar; this is what is in it.
 */

type ToolButtonsProps = Readonly<{
	tool: Tool;
	/** The active layer's kind, which the tools shown are fitted to; none with no layer. */
	layerKind: LayerKind | undefined;
	/** Which way the bar runs: down the rail, or across the foot of a compact window. */
	orientation: Orientation;
	fill: string;
	stroke: string;
	/** Whether the color panel is open, which the color pair opens and closes. */
	colorsOpen: boolean;
	layersOpen: boolean;
	dispatch: Dispatch<EditorAction>;
	onLayers: () => void;
}>;

/**
 * The tools in their groups (`ToolGroups`), fitted to the active layer's kind
 * and folded where the bar is short of room; then the colors and the layers,
 * which stay at the bar's far end (`editor.css`). The colors are where the
 * tool's options are set (`data-tool-options`, `tools/optionsRegion.ts`), as
 * the color panel they open is: a color picked or swapped there while the
 * text tool's field is open is the text's.
 */
export const ToolButtons = ({
	tool,
	layerKind,
	orientation,
	fill,
	stroke,
	colorsOpen,
	layersOpen,
	dispatch,
	onLayers,
}: ToolButtonsProps) => (
	<>
		<ToolGroups
			inHand={tool.id}
			layerKind={layerKind}
			orientation={orientation}
			onChoose={(toolId) => dispatch({ type: 'setTool', toolId })}
		/>
		<span className="tool-group-end">
			<span className="tool-options" data-tool-options="">
				<ColorPair
					fill={fill}
					stroke={stroke}
					open={colorsOpen}
					onToggle={() => dispatch({ type: 'togglePanel', panel: 'color' })}
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
