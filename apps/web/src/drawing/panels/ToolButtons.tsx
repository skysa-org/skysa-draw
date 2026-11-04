import type { Dispatch } from 'react';

import { classes } from '../../components/ui/classes.js';
import { isNone } from '../../components/ui/colour.js';
import { ColourIcon, ICONS, LayersIcon } from '../../components/ui/icons.js';
import { ToolButton } from '../../components/ui/ToolButton.js';
import { t } from '../../i18n/t.js';
import type { EditorAction } from '../editorState.js';
import { shortcutLabel } from '../keys.js';
import { TOOLS } from '../tools/index.js';
import type { Tool } from '../tools/types.js';

/**
 * What the tool bar and the rail hold (docs/ARCHITECTURE.md §7, "The
 * interface"): a button per tool, then the colour and the layers. The frame
 * (`Editor.tsx`) places the bar; this is what is in it.
 */

/** The fill as a mark on the colour button; none is a struck-through one. */
const Swatch = ({ colour }: Readonly<{ colour: string }>) => (
	<span
		className={classes('swatch', isNone(colour) && 'swatch-none')}
		// The swatch is drawn in `currentColor` (`ui.css`), so the colour is the one style set here.
		style={isNone(colour) ? undefined : { color: colour }}
		aria-hidden="true"
	/>
);

type ToolButtonsProps = Readonly<{
	tool: Tool;
	fill: string;
	colourOpen: boolean;
	layersOpen: boolean;
	dispatch: Dispatch<EditorAction>;
	onLayers: () => void;
}>;

/**
 * The tools, then the colour and the layers, which stay at the bar's far end
 * while the tools scroll past them on a narrow bar (`editor.css`).
 */
export const ToolButtons = ({
	tool,
	fill,
	colourOpen,
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
			<ToolButton
				icon={<ColourIcon />}
				label={t('editor.colour.title')}
				pressed={colourOpen}
				badge={<Swatch colour={fill} />}
				onClick={() => dispatch({ type: 'togglePanel', panel: 'colour' })}
			/>
			<ToolButton
				icon={<LayersIcon />}
				label={t('layers.title')}
				pressed={layersOpen}
				onClick={onLayers}
			/>
		</span>
	</>
);
