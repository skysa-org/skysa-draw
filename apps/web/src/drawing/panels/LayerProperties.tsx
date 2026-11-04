import { BLEND_MODES, type BlendMode } from '@skysa/draw-core';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { Select } from '../../components/ui/Select.js';
import { Slider } from '../../components/ui/Slider.js';
import { t } from '../../i18n/t.js';
import { renameLayer, setLayerBlend, setLayerOpacity } from '../document/commands.js';
import type { EditorDocument, LayerInfo } from '../document/model.js';
import { layerDisplayName } from '../layerName.js';
import { blendKey } from './blendKey.js';

/**
 * What can be set on a layer besides its place (docs/ARCHITECTURE.md §3,
 * "Layers"): its name, its opacity and its blend mode, each written by a
 * command, so each is undone as a stroke is. One component, under the list in
 * the layers sheet or drawer, and in the properties panel of the dock.
 */

const BLEND_OPTIONS: readonly Readonly<{ value: BlendMode; label: string }>[] = BLEND_MODES.map(
	(mode) => ({ value: mode, label: t(blendKey(mode)) })
);

const percent = (n: number): string => t('editor.units.percent', { n: Math.round(n * 100) });

/**
 * The layer's name as the user types it: a row's rename, and the properties'
 * field. It holds `draw:name` alone, with "Layer n" as the placeholder, so an
 * unnamed layer committed unchanged stays unnamed and no English is written
 * into the file (docs/decisions/0003-layers.md). Enter and leaving the field
 * commit, Escape cancels, and an empty field changes nothing.
 */
export const LayerNameField = ({
	document,
	layer,
	indexFromBottom,
	takeFocus = false,
	onDone,
}: Readonly<{
	document: EditorDocument;
	layer: LayerInfo;
	indexFromBottom: number;
	/** Focused, with its text selected, as it appears: a rename asked for. */
	takeFocus?: boolean;
	onDone?: () => void;
}>) => {
	const ref = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState(layer.name ?? '');
	// Whether Enter or Escape has had its say on what was typed, so that the
	// blur of a field going away with its row does not commit it again, or
	// commit what Escape threw away.
	const settled = useRef(false);
	useEffect(() => {
		if (!takeFocus) return;
		ref.current?.focus();
		ref.current?.select();
	}, [takeFocus]);

	const commit = () => {
		if (settled.current) return;
		settled.current = true;
		const name = draft.trim();
		if (name !== '' && name !== layer.name) document.execute(renameLayer(layer.id, name));
		if (name === '') setDraft(layer.name ?? '');
		onDone?.();
	};
	const cancel = () => {
		settled.current = true;
		setDraft(layer.name ?? '');
		onDone?.();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		// The row around this field reads Delete and the arrows as its own, and
		// the frame the letters; a key typed into the name is the name's.
		event.stopPropagation();
		if (event.key === 'Enter') {
			event.preventDefault();
			commit();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			cancel();
		}
	};

	return (
		<input
			ref={ref}
			className="layer-name-field"
			aria-label={t('layers.name')}
			placeholder={layerDisplayName(layer, indexFromBottom)}
			value={draft}
			onChange={(event) => {
				settled.current = false;
				setDraft(event.target.value);
			}}
			onBlur={commit}
			onKeyDown={onKeyDown}
		/>
	);
};

export const LayerProperties = ({
	document,
	layer,
	indexFromBottom,
}: Readonly<{
	document: EditorDocument;
	layer: LayerInfo;
	/** Where the layer is from the bottom, for the name of a layer that has none. */
	indexFromBottom: number;
}>) => (
	<div className="layer-properties">
		{/* Keyed by the layer and its name, so the draft is the layer's own and
		    follows a rename made in the row or undone. */}
		<LayerNameField
			key={`${layer.id}/${layer.name ?? ''}`}
			document={document}
			layer={layer}
			indexFromBottom={indexFromBottom}
		/>
		<Slider
			label={t('layers.opacity')}
			value={layer.opacity}
			min={0}
			max={1}
			step={0.01}
			format={percent}
			onChange={(opacity) => document.execute(setLayerOpacity(layer.id, opacity))}
		/>
		<Select
			label={t('layers.blend')}
			value={layer.blend}
			options={BLEND_OPTIONS}
			onChange={(blend) => document.execute(setLayerBlend(layer.id, blend))}
		/>
	</div>
);
