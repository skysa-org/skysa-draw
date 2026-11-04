import { Panel } from '../../components/ui/Panel.js';
import { t } from '../../i18n/t.js';
import type { DocumentSnapshot, EditorDocument } from '../document/model.js';
import { LayerProperties } from './LayerProperties.js';

/**
 * The active layer's properties, in the dock under the layers
 * (docs/ARCHITECTURE.md §7, "The interface"): its kind, and the name, opacity
 * and blend mode that the layers sheet and drawer show under their list.
 */
export const PropertiesPanel = ({
	document,
	snapshot,
	activeLayerId,
}: Readonly<{
	document: EditorDocument;
	snapshot: DocumentSnapshot;
	activeLayerId: string | undefined;
}>) => {
	const index = snapshot.layers.findIndex((layer) => layer.id === activeLayerId);
	const layer = snapshot.layers[index];
	return (
		<Panel title={t('editor.panes.properties')} className="properties-panel">
			{layer === undefined ? (
				<p className="panel-empty">{t('layers.noneActive')}</p>
			) : (
				<>
					<p className="layer-kind">{t(`layers.kind.${layer.kind}`)}</p>
					<LayerProperties document={document} layer={layer} indexFromBottom={index} />
				</>
			)}
		</Panel>
	);
};
