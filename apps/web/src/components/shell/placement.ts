import { createContext, useContext } from 'react';

/**
 * Where something said over the library goes (docs/ARCHITECTURE.md §7, "The
 * interface"): a sheet from the bottom on a compact window, a drawer from the
 * side elsewhere, as the editor's own panels are placed (`PanelHost`). The
 * frame reads the size class and says which (`routes/index.tsx`); what opens
 * one — the devices on an account, how its syncing is going — asks here
 * rather than asking how wide the window is.
 */
export type Floating = 'sheet' | 'drawer';

const PlacementContext = createContext<Floating>('drawer');

/** Set by the frame, once, for everything under it. */
export const PlacementProvider = PlacementContext.Provider;

export const useFloatingPlacement = (): Floating => useContext(PlacementContext);
