/**
 * Canvas2D renderer for video frame grid display.
 *
 * Uses ctx.drawImage(VideoFrame, ...) for straightforward rendering.
 * Drop-in replacement for GPURenderer to prove the decode pipeline works.
 */

import { Logger } from '../utils/logger';

/** A viewport definition mapping a stream to a normalized canvas region */
interface Viewport {
  streamId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Canvas2D-based video renderer.
 *
 * Renders decoded VideoFrames into grid cells using drawImage().
 * VideoFrame is a valid CanvasImageSource per the WebCodecs spec.
 *
 * CRITICAL: All VideoFrames passed to renderAll() are closed after rendering.
 */
export class Canvas2DRenderer {
  private ctx: CanvasRenderingContext2D | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private currentViewports: Viewport[] = [];
  private renderCount = 0;
  private readonly log: Logger;

  constructor() {
    this.log = new Logger('Canvas2DRenderer');
  }

  /**
   * Initialize the Canvas2D renderer.
   * @param canvas - The HTML canvas element to render into
   */
  async init(canvas: HTMLCanvasElement): Promise<void> {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get Canvas 2D context');
    }
    this.ctx = ctx;
    this.canvas = canvas;
    this.log.info(`Initialized: canvas ${canvas.width}x${canvas.height}`);
  }

  /**
   * Render all video frames in their grid positions.
   *
   * CRITICAL: All VideoFrames in the map are closed after drawing.
   * Callers must not use the frames after calling this method.
   */
  renderAll(frames: Map<number, VideoFrame>): void {
    if (!this.ctx || !this.canvas) return;

    this.renderCount++;

    const cw = this.canvas.width;
    const ch = this.canvas.height;

    // Clear the entire canvas
    this.ctx.fillStyle = '#111';
    this.ctx.fillRect(0, 0, cw, ch);

    let rendered = 0;
    for (const vp of this.currentViewports) {
      const frame = frames.get(vp.streamId);
      if (!frame) continue;

      // Convert normalized 0..1 coordinates to pixel coordinates
      const dx = Math.round(vp.x * cw);
      const dy = Math.round(vp.y * ch);
      const dw = Math.round(vp.width * cw);
      const dh = Math.round(vp.height * ch);

      try {
        this.ctx.drawImage(frame, dx, dy, dw, dh);
        rendered++;
      } catch (e) {
        this.log.warn(`Failed to draw stream ${vp.streamId}:`, e);
      }
    }

    if (this.renderCount <= 5 || this.renderCount % 60 === 0) {
      this.log.info(`renderAll #${this.renderCount}: rendered ${rendered}/${frames.size} streams`);
    }

    // Close ALL VideoFrames after drawing
    for (const frame of frames.values()) {
      frame.close();
    }
  }

  /**
   * Update the grid layout viewports.
   * @param viewports - Array of viewport definitions with normalized 0..1 coordinates
   */
  updateLayout(viewports: Viewport[]): void {
    this.currentViewports = viewports;
    this.log.info(`Layout updated: ${viewports.length} viewports`);
  }

  /** Get renderer info string. */
  getGPUInfo(): string {
    return 'Canvas2D';
  }

  /** Clean up. */
  destroy(): void {
    this.ctx = null;
    this.canvas = null;
    this.log.info('Renderer destroyed');
  }
}
