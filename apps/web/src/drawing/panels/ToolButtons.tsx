import type { LayerKind } from '@skysa/draw-core';
import { type Dispatch, type ReactNode, useId, useRef } from 'react';

import { ColorPair } from '../../components/ui/ColorPair.js';
import { LayersIcon } from '../../components/ui/icons.js';
import { Popover } from '../../components/ui/Popover.js';
import type { Orientation } from '../../components/ui/ToolBar.js';
import { ToolButton } from '../../components/ui/ToolButton.js';
import { t } from '../../i18n/t.js';
import type { EditorAction } from '../editorState.js';
import type { Tool } from '../tools/types.js';
import { onCanvas } from '../viewport/canvasRegion.js';
import { ToolGroups } from './ToolGroups.js';

/**
 * What the tool bar and the rail hold (docs/ARCHITECTURE.md §7, "The
 * interface"): the tools, then the two colors as one button, with the color
 * panel it opens beside it, and the layers. The swap and the reset are the
 * color panel's. The frame (`Editor.tsx`) places the bar; this is what is in it.
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
	/** The color panel, shown beside the color pair while it is open. */
	colors: ReactNode;
	layersOpen: boolean;
	dispatch: Dispatch<EditorAction>;
	onLayers: () => void;
}>;

/**
 * The tools in their groups (`ToolGroups`), fitted to the active layer's kind
 * and folded where the bar is short of room; then the colors and the layers,
 * which stay at the bar's far end (`editor.css`). The colors are where the
 * tool's options are set (`data-tool-options`, `tools/optionsRegion.ts`), and
 * so is the color panel they open beside them (`Popover`), toward the canvas,
 * as a folded group's menu opens beside its tool: a color picked or swapped
 * there while the text tool's field is open is the text's. A press on the
 * canvas that puts the panel away draws nothing.
 */
export const ToolButtons = ({
	tool,
	layerKind,
	orientation,
	fill,
	stroke,
	colorsOpen,
	colors,
	layersOpen,
	dispatch,
	onLayers,
}: ToolButtonsProps) => {
	const pair = useRef<HTMLButtonElement>(null);
	const panelId = useId();
	return (
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
						ref={pair}
						fill={fill}
						stroke={stroke}
						panel={{ id: panelId, open: colorsOpen }}
						onToggle={() => dispatch({ type: 'togglePanel', panel: 'color' })}
					/>
					<Popover
						id={panelId}
						label={t('editor.color.title')}
						open={colorsOpen}
						anchor={pair}
						orientation={orientation}
						onClose={() => dispatch({ type: 'closePanel' })}
						spends={onCanvas}
					>
						{colors}
					</Popover>
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
};
