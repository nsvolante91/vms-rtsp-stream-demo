/**
 * Per-stream performance metrics overlay.
 *
 * Renders a compact real-time metrics panel in the top-left corner
 * of a stream tile. Updates at 1Hz from cached worker metrics.
 */

/** Data shape passed to the overlay for rendering */
export interface StreamOverlayData {
  fps: number;
  resolution: string;
  droppedFrames: number;
  decodedFrames: number;
  decodeTimeMs: number;
  queueSize: number;
  frameIntervalMs: number;
  frameIntervalJitterMs: number;
  stutterCount: number;
  bitrateKbps: number;
  /** Frames superseded in the render queue before display */
  renderDroppedFrames: number;
  /** Resolution tier driving adaptive thresholds (sd/hd/uhd) */
  resolutionTier: 'sd' | 'hd' | 'uhd';
}

/**
 * Compact metrics overlay positioned at the top-left of a stream tile.
 *
 * Displays FPS, resolution, dropped frames, decode time, queue depth,
 * frame interval, jitter, stutters, and bitrate. FPS values are color-coded
 * (green > 25, yellow 15–25, red < 15). Metrics that indicate degradation
 * are highlighted.
 */
export class StreamOverlay {
  private readonly el: HTMLDivElement;
  private _visible = false;

  constructor(private readonly parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'stream-metrics-overlay';
    this.parent.appendChild(this.el);
  }

  /** Update the overlay content with fresh metrics */
  update(data: StreamOverlayData): void {
    if (!this._visible) return;

    const fpsColor = data.fps > 25 ? 'smo-green' : data.fps >= 15 ? 'smo-yellow' : 'smo-red';
    const dropColor = data.droppedFrames > 0 ? 'smo-red' : '';
    const decodeColor = data.decodeTimeMs > 33 ? 'smo-red' : data.decodeTimeMs > 16 ? 'smo-yellow' : '';
    const queueColor = data.queueSize >= 6 ? 'smo-red' : data.queueSize >= 4 ? 'smo-yellow' : '';
    const jitterColor = data.frameIntervalJitterMs > 10 ? 'smo-yellow' : '';
    const stutterColor = data.stutterCount > 0 ? 'smo-red' : '';
    const renderDropColor = data.renderDroppedFrames > 0 ? 'smo-yellow' : '';

    // Format bitrate: show Mbps if ≥ 1000 kbps
    const bitrateStr = data.bitrateKbps >= 1000
      ? `${(data.bitrateKbps / 1000).toFixed(1)} Mbps`
      : `${data.bitrateKbps.toFixed(0)} kbps`;

    this.el.innerHTML =
      `<div class="smo-row"><span class="smo-label">FPS</span><span class="smo-val ${fpsColor}">${data.fps}</span></div>` +
      `<div class="smo-row"><span class="smo-label">Res</span><span class="smo-val">${data.resolution} <span class="smo-tier">${data.resolutionTier.toUpperCase()}</span></span></div>` +
      `<div class="smo-row"><span class="smo-label">Decode</span><span class="smo-val ${decodeColor}">${data.decodeTimeMs.toFixed(1)} ms</span></div>` +
      `<div class="smo-row"><span class="smo-label">Queue</span><span class="smo-val ${queueColor}">${data.queueSize}</span></div>` +
      `<div class="smo-row"><span class="smo-label">Interval</span><span class="smo-val">${data.frameIntervalMs.toFixed(1)} ms</span></div>` +
      `<div class="smo-row"><span class="smo-label">Jitter</span><span class="smo-val ${jitterColor}">${data.frameIntervalJitterMs.toFixed(1)} ms</span></div>` +
      `<div class="smo-row"><span class="smo-label">Stutters</span><span class="smo-val ${stutterColor}">${data.stutterCount}</span></div>` +
      `<div class="smo-row"><span class="smo-label">Dropped</span><span class="smo-val ${dropColor}">${data.droppedFrames}</span></div>` +
      `<div class="smo-row"><span class="smo-label">Render Drop</span><span class="smo-val ${renderDropColor}">${data.renderDroppedFrames}</span></div>` +
      `<div class="smo-row"><span class="smo-label">Decoded</span><span class="smo-val">${data.decodedFrames}</span></div>` +
      `<div class="smo-row"><span class="smo-label">Bitrate</span><span class="smo-val">${bitrateStr}</span></div>`;
  }

  show(): void {
    this._visible = true;
    this.el.classList.add('visible');
  }

  hide(): void {
    this._visible = false;
    this.el.classList.remove('visible');
  }

  destroy(): void {
    this.el.remove();
  }
}
