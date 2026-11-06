/**
 * The tools, by the names users know them by, and the options they share
 * (docs/decisions/0004-the-interface.md). One tool is one tool on a vector
 * layer and on a raster one, so each has one name. `{tool}` is a tool's name.
 */
export const tools = {
	select: 'Select',
	node: 'Node',
	hand: 'Hand',
	zoom: 'Zoom',
	pencil: 'Pencil',
	brush: 'Brush',
	eraser: 'Eraser',
	smudge: 'Smudge',
	/** Photoshop's Remove tool: paint over something, and it is made again from what is around it. */
	remove: 'Remove',
	/** Photoshop's Red Eye tool: a click on a pupil a flash turned red darkens it. */
	redEye: 'Red eye',
	fill: 'Fill',
	eyedropper: 'Eyedropper',
	rectangle: 'Rectangle',
	ellipse: 'Ellipse',
	line: 'Line',
	pen: 'Pen',
	text: 'Text',
	marquee: 'Marquee',
	lasso: 'Lasso',
	wand: 'Magic wand',
	crop: 'Crop',
	/**
	 * The tool bar's groups, in Photoshop's order (`drawing/tools/groups.ts`):
	 * each names the menu a folded group opens.
	 */
	groups: {
		move: 'Move tools',
		select: 'Selection tools',
		crop: 'Crop and sample tools',
		retouch: 'Retouching tools',
		paint: 'Painting tools',
		draw: 'Pen and type tools',
		shape: 'Shape tools',
		view: 'Navigation tools',
	},
	options: {
		size: 'Size',
		opacity: 'Opacity',
		hardness: 'Hardness',
		smoothing: 'Smoothing',
		pressure: 'Pressure',
		fill: 'Fill',
		stroke: 'Stroke',
		strokeWidth: 'Stroke width',
		cornerRadius: 'Corner radius',
		tolerance: 'Tolerance',
		/** A shape or a selection kept to a square, a circle, a straight angle. */
		constrain: 'Constrain',
		fontSize: 'Font size',
		strength: 'Strength',
		/** The magic wand: only the pixels joined to the one clicked, or every one of its color. */
		contiguous: 'Contiguous',
		/** The move tool: a press first makes the topmost layer with something under it the active one, as Photoshop's Auto-Select. */
		autoSelect: 'Auto-select',
		/** The selection tools' four modes, as a group: new, add, subtract, intersect. */
		areaMode: 'Selection mode',
		/** The red eye tool: how much of the red around a click is darkened, as Photoshop's Pupil Size. */
		pupilSize: 'Pupil size',
		/** The red eye tool: how dark the corrected pupil is made, as Photoshop's Darken Amount. */
		darken: 'Darken amount',
		/** The move tool: what the layers are aligned to, as Photoshop's Align To. */
		alignTo: 'Align to',
		/** The move tool: what Auto-select picks, the layer or its outermost group, as Photoshop's menu beside Auto-Select. */
		autoSelectMode: 'Auto-select picks',
		/** The move tool: a move snaps to the canvas and to the other layers, as Photoshop's View › Snap. */
		snap: 'Snap',
	},
	/** What Auto-select picks, as Photoshop's names for the two. */
	autoSelectModes: {
		layer: 'Layer',
		group: 'Group',
	},
	/**
	 * The move tool's alignment, as Photoshop's options bar has it
	 * (`drawing/tools/common/align.ts`): six buttons, then a menu of the
	 * distributions and what the layers are aligned to.
	 */
	align: {
		/** The six buttons, as a group. */
		bar: 'Align',
		left: 'Align left edges',
		centerX: 'Align horizontal centers',
		right: 'Align right edges',
		top: 'Align top edges',
		centerY: 'Align vertical centers',
		bottom: 'Align bottom edges',
		/** The menu after the six buttons. */
		more: 'More alignment',
		distribute: {
			top: 'Distribute top edges',
			centerY: 'Distribute vertical centers',
			bottom: 'Distribute bottom edges',
			left: 'Distribute left edges',
			centerX: 'Distribute horizontal centers',
			right: 'Distribute right edges',
			/** The same gap between each layer and the next, top to bottom. */
			spaceY: 'Distribute vertical spacing',
			/** The same gap between each layer and the next, left to right. */
			spaceX: 'Distribute horizontal spacing',
		},
		/** What the layers are lined up with, one of the two, in the same menu. */
		to: {
			selection: 'Align to selection',
			canvas: 'Align to canvas',
		},
		/** What undo calls an alignment, and a distribution. */
		aligned: 'Align layers',
		distributed: 'Distribute layers',
		/** The layers to align paint nothing that could be measured. */
		nothing: 'There is nothing on these layers to align.',
	},
	/**
	 * The selection tools' four modes, each a button of the group, by
	 * Photoshop's names for them: what the next outline does with what is
	 * selected.
	 */
	areaModes: {
		/** The outline is the selection, in place of what was. */
		new: 'New selection',
		/** The outline is added to what is selected. */
		add: 'Add to selection',
		/** The outline is taken out of what is selected. */
		subtract: 'Subtract from selection',
		/** What is selected is kept only where the outline is too. */
		intersect: 'Intersect with selection',
	},
	/** The magic wand on a raster layer whose picture would not decode: nothing is selected. */
	wandUnreadable: 'This layer’s picture could not be read, so nothing can be selected from it.',
	/** The magic wand's outline would be too long to use as a selection: nothing is selected. */
	wandTooDetailed: 'That selection has too many edges to make. Try a higher tolerance.',
	/** A tool that does nothing on the active layer's kind. */
	notOnVector: '{tool} does not work on a vector layer.',
	notOnRaster: '{tool} does not work on a raster layer.',
	notOnGroup: '{tool} does not work on a group. Choose a layer inside it.',
} as const;
