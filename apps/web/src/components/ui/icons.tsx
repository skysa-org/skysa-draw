import type { ReactNode } from 'react';

/**
 * The app's icons (docs/ARCHITECTURE.md §7, "The interface"), drawn by hand on
 * a 24 px grid as single-weight lines, in the manner of Lucide and Feather but
 * none of theirs. Each one is decoration: the control it sits in carries the
 * name, so the SVG is hidden from a screen reader and takes no focus.
 */
export interface IconProps {
	readonly size?: number;
	readonly className?: string;
}

const Icon = ({
	size = 24,
	className,
	children,
}: IconProps & Readonly<{ children: ReactNode }>) => (
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="none"
		stroke="currentColor"
		strokeWidth={1.75}
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		focusable="false"
		className={className}
	>
		{children}
	</svg>
);

/** A point an icon marks: a dot, filled, since a ring this small reads as a smudge. */
const Dot = ({ cx, cy }: Readonly<{ cx: number; cy: number }>) => (
	<circle cx={cx} cy={cy} r={1.4} fill="currentColor" stroke="none" />
);

// ---- Tools --------------------------------------------------------------------

const SelectIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M5 4l15 7.5-6.5 1.8-2 6.2z" />
	</Icon>
);

const NodeIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M6 16c0-8 12-4 12-10" />
		<rect x="4" y="16" width="4" height="4" />
		<rect x="16" y="4" width="4" height="4" />
	</Icon>
);

const HandIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M7.5 13V7a1.5 1.5 0 0 1 3 0v5.5" />
		<path d="M10.5 12V5a1.5 1.5 0 0 1 3 0v7" />
		<path d="M13.5 12V6.5a1.5 1.5 0 0 1 3 0V13" />
		<path d="M16.5 13v-1a1.5 1.5 0 0 1 3 0v4" />
		<path d="M19.5 16c0 3.5-2.5 6-6 6h-1.6c-2.1 0-3.7-1-4.8-2.6L4.3 15.2a1.5 1.5 0 0 1 2.4-1.7L7.5 15" />
	</Icon>
);

const ZoomIcon = (props: IconProps) => (
	<Icon {...props}>
		<circle cx="10.5" cy="10.5" r="6.5" />
		<path d="M15.3 15.3l5.2 5.2" />
	</Icon>
);

const PencilIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z" />
		<path d="M14 7l3 3" />
	</Icon>
);

const BrushIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M20.5 3.5a1.8 1.8 0 0 0-2.5 0L10 11.5l2.5 2.5 8-8a1.8 1.8 0 0 0 0-2.5z" />
		<path d="M10 11.5c-2.5-.5-4.5 1-5 3.5-.4 2-1 3.5-2 4.5 3 .5 6 0 7.5-1.5 1.3-1.3 2-3 2-4.5" />
	</Icon>
);

const EraserIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M20 20H9.5l-5.3-5.3a2 2 0 0 1 0-2.8l8.2-8.2a2 2 0 0 1 2.8 0l5.1 5.1a2 2 0 0 1 0 2.8L13.6 18.3" />
		<path d="M7 10.5l6.5 6.5" />
	</Icon>
);

const SmudgeIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M9 13.5V4.5a2 2 0 0 1 4 0V11" />
		<path d="M13 11l4 1.2c1.7.5 2.5 1.8 2.5 3.3V21H8v-3.2L4.6 14a1.5 1.5 0 0 1 2.5-1.7L9 14.5" />
		<path d="M16.5 4h3.5M18 7.5h3" />
	</Icon>
);

const RemoveIcon = (props: IconProps) => (
	<Icon {...props}>
		{/*
		 * A dashed shape being painted away, a solid brush tip in it and one small
		 * solid sparkle: the shape, not a stroke, is what the eye meets first, which
		 * the brush, the eraser, the eyedropper and the wand have none of.
		 */}
		<circle cx="10" cy="14" r="6.5" strokeDasharray="1 3.54" />
		<path d="M16 7l2.5 2.5-3 3Q13.9 13.6 11.75 13.75 11.9 11.6 13 10z" fill="currentColor" />
		<path d="M17.25 8.25l3.5-3.5" />
		<path
			d="M20 17c.3 1.5 1 2.2 2.5 2.5-1.5.3-2.2 1-2.5 2.5-.3-1.5-1-2.2-2.5-2.5 1.5-.3 2.2-1 2.5-2.5z"
			fill="currentColor"
			stroke="none"
		/>
	</Icon>
);

const RedEyeIcon = (props: IconProps) => (
	<Icon {...props}>
		{/*
		 * An almond eye, its lids meeting in points, with an iris and a solid pupil
		 * in it and a flash's three rays off its corner: the layers' eye (`EyeIcon`)
		 * is wide and round-lidded, with an open pupil and nothing beside it.
		 */}
		<path d="M2 15q8.5-9 17 0-8.5 9-17 0z" />
		<circle cx="10.5" cy="15" r="3" />
		<circle cx="10.5" cy="15" r="1.3" fill="currentColor" stroke="none" />
		<path d="M17 6V3.5M19.1 6.9l1.8-1.8M20 9h2.5" />
	</Icon>
);

const FillIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M4.5 11.5l7-7 8 8-6.5 6.5a1.4 1.4 0 0 1-2 0L4.5 13.5a1.4 1.4 0 0 1 0-2z" />
		<path d="M4.5 11.5h14" />
		<path d="M11.5 4.5L9 2" />
		<path d="M20 14.5c.6 1.4 1.5 2.5 1.5 3.6a1.5 1.5 0 0 1-3 0c0-1.1.9-2.2 1.5-3.6z" />
	</Icon>
);

const EyedropperIcon = (props: IconProps) => (
	<Icon {...props}>
		{/* A solid bulb, a collar wider than it and a drop at the tip: what the pencil has none of. */}
		<path d="M15.5 5.1l1.9-1.9a2.4 2.4 0 0 1 3.4 3.4l-1.9 1.9z" fill="currentColor" />
		<path d="M13.4 5l5.6 5.6" />
		<path d="M15 7.8L6.8 16.7l8.9-8.2" />
		<path
			d="M6 18.9c.7 1.1 1.3 1.9 1.3 2.6a1.3 1.3 0 0 1-2.6 0c0-.7.6-1.5 1.3-2.6z"
			fill="currentColor"
			stroke="none"
		/>
	</Icon>
);

const RectangleIcon = (props: IconProps) => (
	<Icon {...props}>
		<rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
	</Icon>
);

const EllipseIcon = (props: IconProps) => (
	<Icon {...props}>
		<ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
	</Icon>
);

const LineIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M6.5 17.5l11-11" />
		<Dot cx={5} cy={19} />
		<Dot cx={19} cy={5} />
	</Icon>
);

const PenIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M12 21.5L5.5 9.5A7 7 0 0 1 12 2.5a7 7 0 0 1 6.5 7z" />
		<path d="M12 21.5v-9" />
		<circle cx="12" cy="11" r="1.5" />
	</Icon>
);

const TextIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M5 6.5V4h14v2.5" />
		<path d="M12 4v16" />
		<path d="M9 20h6" />
	</Icon>
);

const MarqueeIcon = (props: IconProps) => (
	<Icon {...props}>
		<rect x="3.5" y="5.5" width="17" height="13" rx="1" strokeDasharray="3.5 2.5" />
	</Icon>
);

const LassoIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M7.5 14.3C4.9 13.4 3.5 12 3.5 10.3 3.5 7.1 7.3 4.5 12 4.5s8.5 2.6 8.5 5.8c0 3.2-3.8 5.8-8.5 5.8-.6 0-1.2 0-1.8-.1" />
		<path d="M7.5 14.3c-1 1-1.5 2.4-1.5 3.7 0 1.2.7 2.5 1.5 3.5" />
		<circle cx="7.5" cy="14.5" r="1.3" />
	</Icon>
);

const WandIcon = (props: IconProps) => (
	<Icon {...props}>
		{/* A stick with a band at its tip, and a sparkle off it: no point, as the pencil and the brush have. */}
		<path d="M4.6 21.2l-1.8-1.8 9.7-9.7 1.8 1.8z" />
		<path d="M10.2 12l1.8 1.8" />
		<path d="M17 2.5c.4 2.4 1.6 3.6 4 4-2.4.4-3.6 1.6-4 4-.4-2.4-1.6-3.6-4-4 2.4-.4 3.6-1.6 4-4z" />
		<path d="M20.5 14v2.5M19.25 15.25h2.5" />
	</Icon>
);

const CropIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M6.5 2.5v15h15" />
		<path d="M2.5 6.5h15v15" />
	</Icon>
);

// ---- The selection tools' modes -----------------------------------------------
// Photoshop's four: what is selected after is filled, and the outlines met are drawn.

const AreaNewIcon = (props: IconProps) => (
	<Icon {...props}>
		<rect x="5.5" y="5.5" width="13" height="13" fill="currentColor" />
	</Icon>
);

const AreaAddIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M3.5 3.5h11v6h6v11h-11v-6h-6z" fill="currentColor" />
	</Icon>
);

const AreaSubtractIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M3.5 3.5h11v6h-5v5h-6z" fill="currentColor" />
		<rect x="9.5" y="9.5" width="11" height="11" />
	</Icon>
);

const AreaIntersectIcon = (props: IconProps) => (
	<Icon {...props}>
		<rect x="3.5" y="3.5" width="11" height="11" />
		<rect x="9.5" y="9.5" width="11" height="11" />
		<rect x="9.5" y="9.5" width="5" height="5" fill="currentColor" />
	</Icon>
);

// ---- The move tool's alignment ------------------------------------------------
// Photoshop's and Figma's: an alignment is a guide with two bars of different
// lengths set against it; a distribution is three bars with the edges or the
// centers it spaces evenly marked, or, for the spacing, one bar midway between
// two guides. A center's guide or marks stop at the bars rather than cross
// them, so each bar reads whole.

/** What lines the bars up, a guide or the marks of their edges or centers, and the bars, outlined. */
const Arranged = ({
	guide,
	bars,
	...props
}: IconProps & Readonly<{ guide: string; bars: string }>) => (
	<Icon {...props}>
		<path d={guide} />
		<path d={bars} />
	</Icon>
);

/** Three bars standing side by side, of different heights, 7 apart edge to edge and center to center. */
const BARS_ACROSS = 'M3 7h4v10h-4zM10 9h4v6h-4zM17 6h4v12h-4z';
/** The same three lying down, one over another. */
const BARS_DOWN = 'M7 3h10v4h-10zM9 10h6v4h-6zM6 17h12v4h-12z';

const AlignLeftIcon = (props: IconProps) => (
	<Arranged {...props} guide="M3.5 3v18" bars="M6.5 5.5h14v5h-14zM6.5 13.5h8v5h-8z" />
);

const AlignCenterXIcon = (props: IconProps) => (
	<Arranged
		{...props}
		guide="M12 2.5v3M12 10.5v3M12 18.5v3"
		bars="M4.5 5.5h15v5h-15zM7.5 13.5h9v5h-9z"
	/>
);

const AlignRightIcon = (props: IconProps) => (
	<Arranged {...props} guide="M20.5 3v18" bars="M3.5 5.5h14v5h-14zM9.5 13.5h8v5h-8z" />
);

const AlignTopIcon = (props: IconProps) => (
	<Arranged {...props} guide="M3 3.5h18" bars="M5.5 6.5h5v14h-5zM13.5 6.5h5v8h-5z" />
);

const AlignCenterYIcon = (props: IconProps) => (
	<Arranged
		{...props}
		guide="M2.5 12h3M10.5 12h3M18.5 12h3"
		bars="M5.5 4.5h5v15h-5zM13.5 7.5h5v9h-5z"
	/>
);

const AlignBottomIcon = (props: IconProps) => (
	<Arranged {...props} guide="M3 20.5h18" bars="M5.5 3.5h5v14h-5zM13.5 9.5h5v8h-5z" />
);

const DistributeTopIcon = (props: IconProps) => (
	<Arranged {...props} guide="M3 3h18M3 10h18M3 17h18" bars={BARS_DOWN} />
);

const DistributeCenterYIcon = (props: IconProps) => (
	<Arranged {...props} guide="M3 5h4M17 5h4M3 12h6M15 12h6M3 19h3M18 19h3" bars={BARS_DOWN} />
);

const DistributeBottomIcon = (props: IconProps) => (
	<Arranged {...props} guide="M3 7h18M3 14h18M3 21h18" bars={BARS_DOWN} />
);

const DistributeLeftIcon = (props: IconProps) => (
	<Arranged {...props} guide="M3 3v18M10 3v18M17 3v18" bars={BARS_ACROSS} />
);

const DistributeCenterXIcon = (props: IconProps) => (
	<Arranged {...props} guide="M5 3v4M5 17v4M12 3v6M12 15v6M19 3v3M19 18v3" bars={BARS_ACROSS} />
);

const DistributeRightIcon = (props: IconProps) => (
	<Arranged {...props} guide="M7 3v18M14 3v18M21 3v18" bars={BARS_ACROSS} />
);

const DistributeSpaceYIcon = (props: IconProps) => (
	<Arranged {...props} guide="M3 3.5h18M3 20.5h18" bars="M6 9.5h12v5h-12z" />
);

const DistributeSpaceXIcon = (props: IconProps) => (
	<Arranged {...props} guide="M3.5 3v18M20.5 3v18" bars="M9.5 6h5v12h-5z" />
);

// ---- Panels and the top bar ---------------------------------------------------

export const LayersIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M12 3l9 4.5-9 4.5L3 7.5z" />
		<path d="M3 12l9 4.5 9-4.5" />
		<path d="M3 16.5L12 21l9-4.5" />
	</Icon>
);

const ColorIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-.6-.3-1-.7-1.4-.4-.4-.6-.8-.6-1.3 0-1 .8-1.8 1.8-1.8H16c2.8 0 5-2.2 5-5 0-3.7-4-6.7-9-6.7z" />
		<Dot cx={7.5} cy={11} />
		<Dot cx={9.5} cy={7.3} />
		<Dot cx={13.5} cy={6.5} />
		<Dot cx={16.8} cy={9.3} />
	</Icon>
);

export const UndoIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M9 14L4 9l5-5" />
		<path d="M4 9h11a5 5 0 0 1 0 10h-6" />
	</Icon>
);

export const RedoIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M15 14l5-5-5-5" />
		<path d="M20 9H9a5 5 0 0 0 0 10h6" />
	</Icon>
);

export const MoreIcon = (props: IconProps) => (
	<Icon {...props}>
		<Dot cx={5} cy={12} />
		<Dot cx={12} cy={12} />
		<Dot cx={19} cy={12} />
	</Icon>
);

export const BackIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M19 12H5" />
		<path d="M11 6l-6 6 6 6" />
	</Icon>
);

export const LibraryIcon = (props: IconProps) => (
	<Icon {...props}>
		<rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
		<rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
		<rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
		<rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
	</Icon>
);

export const AddIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M12 5v14M5 12h14" />
	</Icon>
);

export const DeleteIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M4 7h16" />
		<path d="M9.5 7V4.5h5V7" />
		<path d="M6 7l1 13h10l1-13" />
		<path d="M10 11v5M14 11v5" />
	</Icon>
);

export const DuplicateIcon = (props: IconProps) => (
	<Icon {...props}>
		<rect x="8.5" y="8.5" width="12" height="12" rx="1.5" />
		<path d="M15.5 8.5V5A1.5 1.5 0 0 0 14 3.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5" />
	</Icon>
);

export const EyeIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
		<circle cx="12" cy="12" r="3" />
	</Icon>
);

export const EyeOffIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M4 4l16 16" />
		<path d="M10.3 6c.5-.1 1.1-.1 1.7-.1 6 0 9.5 6.5 9.5 6.5-.6 1-1.4 2.2-2.4 3.2" />
		<path d="M6.6 7.4C4 9.3 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.5 0 2.9-.4 4.1-1" />
		<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
	</Icon>
);

export const LockIcon = (props: IconProps) => (
	<Icon {...props}>
		<rect x="5" y="11" width="14" height="10" rx="2" />
		<path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
	</Icon>
);

export const UnlockIcon = (props: IconProps) => (
	<Icon {...props}>
		<rect x="5" y="11" width="14" height="10" rx="2" />
		<path d="M8 11V7.5a4 4 0 0 1 7.6-1.8" />
	</Icon>
);

export const ChevronUpIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M6 15l6-6 6 6" />
	</Icon>
);

export const ChevronDownIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M6 9l6 6 6-6" />
	</Icon>
);

const ChevronLeftIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M15 6l-6 6 6 6" />
	</Icon>
);

const ChevronRightIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M9 6l6 6-6 6" />
	</Icon>
);

export const CloseIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M6 6l12 12M18 6L6 18" />
	</Icon>
);

export const CheckIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M4.5 12.5l5 5 10-11" />
	</Icon>
);

const ZoomInIcon = (props: IconProps) => (
	<Icon {...props}>
		<circle cx="10.5" cy="10.5" r="6.5" />
		<path d="M15.3 15.3l5.2 5.2" />
		<path d="M7.5 10.5h6M10.5 7.5v6" />
	</Icon>
);

const ZoomOutIcon = (props: IconProps) => (
	<Icon {...props}>
		<circle cx="10.5" cy="10.5" r="6.5" />
		<path d="M15.3 15.3l5.2 5.2" />
		<path d="M7.5 10.5h6" />
	</Icon>
);

const FitIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M3.5 8.5v-5h5" />
		<path d="M15.5 3.5h5v5" />
		<path d="M20.5 15.5v5h-5" />
		<path d="M8.5 20.5h-5v-5" />
	</Icon>
);

export const FolderIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z" />
	</Icon>
);

const GroupIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z" />
		<path d="M8.5 12.5l3.5 1.7 3.5-1.7" />
		<path d="M8.5 15.2l3.5 1.7 3.5-1.7" />
	</Icon>
);

/**
 * A group's own row: the folder of `GroupIcon` with a caret in it in place of
 * the layers, pointing down while the group shows its layers and to the side
 * while it is collapsed, as a tree's disclosure turns.
 */
export const GroupToggleIcon = ({ open, ...props }: IconProps & Readonly<{ open: boolean }>) => (
	<Icon {...props}>
		<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z" />
		<path d={open ? 'M8.75 12l3.25 3.25 3.25-3.25' : 'M10.5 10.25l3.25 3.25-3.25 3.25'} />
	</Icon>
);

/** A row's grip, by which a finger drags it to another place in its list: two columns of dots, as a reorder handle is drawn. */
export const GripIcon = (props: IconProps) => (
	<Icon {...props}>
		<Dot cx={9} cy={6} />
		<Dot cx={15} cy={6} />
		<Dot cx={9} cy={12} />
		<Dot cx={15} cy={12} />
		<Dot cx={9} cy={18} />
		<Dot cx={15} cy={18} />
	</Icon>
);

const MergeIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M12 3.5v11" />
		<path d="M7.5 10l4.5 4.5 4.5-4.5" />
		<path d="M4.5 20.5h15" />
	</Icon>
);

export const RasterIcon = (props: IconProps) => (
	<Icon {...props}>
		<rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
		<path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17" />
	</Icon>
);

export const VectorIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M3.5 18.5c4-8 13-8 17 0" />
		<path d="M5 12.5h14" />
		<circle cx="5" cy="12.5" r="1.5" />
		<circle cx="19" cy="12.5" r="1.5" />
		<rect x="10.5" y="11" width="3" height="3" />
	</Icon>
);

export const SwapIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M4 7.5h16" />
		<path d="M16 3.5l4 4-4 4" />
		<path d="M20 16.5H4" />
		<path d="M8 12.5l-4 4 4 4" />
	</Icon>
);

const ExportIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M12 15V3.5" />
		<path d="M7.5 8L12 3.5 16.5 8" />
		<path d="M4.5 14.5v4a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4" />
	</Icon>
);

const SaveIcon = (props: IconProps) => (
	<Icon {...props}>
		<path d="M5 3.5h11l3.5 3.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z" />
		<path d="M7.5 20.5v-7h9v7" />
		<path d="M7.5 3.5v4h7" />
	</Icon>
);

/**
 * Every icon by its name, for a caller that has one as a string: a tool's id,
 * say. The tools' icons are reached only through here, so only the icons some
 * caller names directly are exported on their own as well.
 */
export const ICONS = {
	select: SelectIcon,
	node: NodeIcon,
	hand: HandIcon,
	zoom: ZoomIcon,
	pencil: PencilIcon,
	brush: BrushIcon,
	eraser: EraserIcon,
	smudge: SmudgeIcon,
	remove: RemoveIcon,
	redEye: RedEyeIcon,
	fill: FillIcon,
	eyedropper: EyedropperIcon,
	rectangle: RectangleIcon,
	ellipse: EllipseIcon,
	line: LineIcon,
	pen: PenIcon,
	text: TextIcon,
	marquee: MarqueeIcon,
	lasso: LassoIcon,
	wand: WandIcon,
	crop: CropIcon,
	areaNew: AreaNewIcon,
	areaAdd: AreaAddIcon,
	areaSubtract: AreaSubtractIcon,
	areaIntersect: AreaIntersectIcon,
	alignLeft: AlignLeftIcon,
	alignCenterX: AlignCenterXIcon,
	alignRight: AlignRightIcon,
	alignTop: AlignTopIcon,
	alignCenterY: AlignCenterYIcon,
	alignBottom: AlignBottomIcon,
	distributeTop: DistributeTopIcon,
	distributeCenterY: DistributeCenterYIcon,
	distributeBottom: DistributeBottomIcon,
	distributeLeft: DistributeLeftIcon,
	distributeCenterX: DistributeCenterXIcon,
	distributeRight: DistributeRightIcon,
	distributeSpaceY: DistributeSpaceYIcon,
	distributeSpaceX: DistributeSpaceXIcon,
	layers: LayersIcon,
	color: ColorIcon,
	undo: UndoIcon,
	redo: RedoIcon,
	more: MoreIcon,
	back: BackIcon,
	library: LibraryIcon,
	add: AddIcon,
	delete: DeleteIcon,
	duplicate: DuplicateIcon,
	eye: EyeIcon,
	eyeOff: EyeOffIcon,
	lock: LockIcon,
	unlock: UnlockIcon,
	chevronUp: ChevronUpIcon,
	chevronDown: ChevronDownIcon,
	chevronLeft: ChevronLeftIcon,
	chevronRight: ChevronRightIcon,
	close: CloseIcon,
	check: CheckIcon,
	zoomIn: ZoomInIcon,
	zoomOut: ZoomOutIcon,
	fit: FitIcon,
	folder: FolderIcon,
	group: GroupIcon,
	grip: GripIcon,
	merge: MergeIcon,
	raster: RasterIcon,
	vector: VectorIcon,
	swap: SwapIcon,
	export: ExportIcon,
	save: SaveIcon,
} as const;
