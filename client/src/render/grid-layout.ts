/**
 * Grid layout calculator for arranging video streams on the canvas.
 *
 * Provides two layout modes: equal-cell grid and focus layout
 * with a primary stream and sidebar thumbnails. Includes mobile-aware
 * column suggestion and portrait-aware focus layout.
 */

/** A viewport rectangle in normalized 0..1 canvas coordinates */
export interface GridViewport {
  /** Stream identifier */
  streamId: number;
  /** Left edge (0..1) */
  x: number;
  /** Top edge (0..1) */
  y: number;
  /** Width (0..1) */
  width: number;
  /** Height (0..1) */
  height: number;
}

/**
 * Calculate an equal-cell grid layout for the given streams.
 *
 * Divides the canvas into a grid with the specified number of columns.
 * The number of rows is determined by how many streams need to be placed.
 * Cells are filled left-to-right, top-to-bottom.
 *
 * @param streamIds - Array of stream identifiers to lay out
 * @param columns - Number of columns in the grid
 * @returns Array of viewport rectangles, one per stream
 */
export function calculateGrid(streamIds: number[], columns: number): GridViewport[] {
  if (streamIds.length === 0 || columns <= 0) {
    return [];
  }

  const cols = Math.max(1, columns);
  const rows = Math.ceil(streamIds.length / cols);
  const cellWidth = 1 / cols;
  const cellHeight = 1 / rows;

  return streamIds.map((streamId, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      streamId,
      x: col * cellWidth,
      y: row * cellHeight,
      width: cellWidth,
      height: cellHeight,
    };
  });
}

/**
 * Suggest optimal column count based on stream count, aspect ratio, and device.
 *
 * On portrait mobile, prefers 1 column (streams stack vertically, ideal for
 * 16:9 video). On landscape mobile, uses standard sqrt-based grid.
 * Desktop behavior is unchanged (returns null to indicate no suggestion).
 *
 * @param streamCount - Number of active streams
 * @param containerAspect - Container width / height ratio
 * @param isMobile - Whether the device is detected as mobile
 * @returns Suggested column count, or null to keep current layout
 */
export function suggestColumns(streamCount: number, containerAspect: number, isMobile: boolean): number | null {
  if (streamCount <= 0) return null;

  if (isMobile) {
    // Portrait: single column for vertical stacking
    if (containerAspect < 1) {
      return 1;
    }
    // Landscape mobile: 2 columns for 2+ streams
    return streamCount > 1 ? 2 : 1;
  }

  // Desktop: no suggestion (user controls layout)
  return null;
}

/**
 * Calculate a focus layout with one primary stream and a sidebar of thumbnails.
 *
 * The focused stream occupies 75% of the canvas width on the left side.
 * Remaining streams are stacked vertically in a 25% sidebar on the right.
 * If only one stream exists, it fills the entire canvas.
 *
 * On portrait mobile, switches to a vertical split: focused stream on top (70%),
 * sidebar streams in a horizontal row on the bottom (30%).
 *
 * @param streamIds - Array of stream identifiers to lay out
 * @param focusId - Stream identifier to display as the primary (focused) stream
 * @param isPortrait - Whether the container is in portrait orientation
 * @returns Array of viewport rectangles, one per stream
 */
export function calculateFocusLayout(streamIds: number[], focusId: number, isPortrait = false): GridViewport[] {
  if (streamIds.length === 0) {
    return [];
  }

  if (streamIds.length === 1) {
    return [{
      streamId: streamIds[0],
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }];
  }

  const viewports: GridViewport[] = [];
  const sidebarStreams = streamIds.filter(id => id !== focusId);

  if (isPortrait) {
    // Portrait: 70/30 vertical split — focused on top, sidebar row on bottom
    viewports.push({
      streamId: focusId,
      x: 0,
      y: 0,
      width: 1,
      height: 0.7,
    });

    const sidebarCellWidth = sidebarStreams.length > 0 ? 1 / sidebarStreams.length : 0;
    for (let i = 0; i < sidebarStreams.length; i++) {
      viewports.push({
        streamId: sidebarStreams[i],
        x: i * sidebarCellWidth,
        y: 0.7,
        width: sidebarCellWidth,
        height: 0.3,
      });
    }
  } else {
    // Landscape: 75/25 horizontal split — focused on left, sidebar on right
    viewports.push({
      streamId: focusId,
      x: 0,
      y: 0,
      width: 0.75,
      height: 1,
    });

    const sidebarCellHeight = sidebarStreams.length > 0 ? 1 / sidebarStreams.length : 0;
    for (let i = 0; i < sidebarStreams.length; i++) {
      viewports.push({
        streamId: sidebarStreams[i],
        x: 0.75,
        y: i * sidebarCellHeight,
        width: 0.25,
        height: sidebarCellHeight,
      });
    }
  }

  return viewports;
}
