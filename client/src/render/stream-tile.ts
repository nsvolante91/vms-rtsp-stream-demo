/**
 * Per-stream video tile with its own canvas element.
 *
 * Each tile creates a wrapper div containing a <canvas> for video rendering
 * and a label overlay showing stream info. ResizeObserver keeps the canvas
 * backing store matched to its CSS size.
 */

import { Logger } from '../utils/logger';

/**
 * A single video stream tile with its own canvas and label overlay.
 *
 * CRITICAL: The drawFrame() method calls frame.close() after rendering.
 * Callers must not use the frame after passing it to drawFrame().
 */
export class StreamTile {
  /** The outer wrapper div to append to the grid container */
  readonly element: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly label: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly log: Logger;

  constructor(readonly streamId: number) {
    this.log = new Logger(`Tile[${streamId}]`);

    // Wrapper div
    this.element = document.createElement('div');
    this.element.className = 'stream-tile';
    this.element.dataset.streamId = String(streamId);

    // Canvas fills the tile
    this.canvas = document.createElement('canvas');
    this.element.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx = ctx;

    // Label overlay
    this.label = document.createElement('div');
    this.label.className = 'stream-label';
    this.label.textContent = `Stream ${streamId}`;
    this.element.appendChild(this.label);

    // Keep canvas backing store matched to CSS display size
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const dpr = window.devicePixelRatio || 1;
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        if (w > 0 && h > 0) {
          this.canvas.width = Math.round(w * dpr);
          this.canvas.height = Math.round(h * dpr);
        }
      }
    });
    this.resizeObserver.observe(this.canvas);
  }

  /**
   * Draw a decoded VideoFrame to this tile's canvas and close it.
   *
   * CRITICAL: The frame is closed after drawing. Do not use the frame
   * after calling this method.
   */
  drawFrame(frame: VideoFrame): void {
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    frame.close();
  }

  /** Update the label overlay text. */
  updateLabel(resolution: string, fps: number): void {
    this.label.textContent = `Stream ${this.streamId} | ${resolution} | ${fps} fps`;
  }

  /** Remove from DOM and clean up. */
  destroy(): void {
    this.resizeObserver.disconnect();
    this.element.remove();
    this.log.info('Destroyed');
  }
}
