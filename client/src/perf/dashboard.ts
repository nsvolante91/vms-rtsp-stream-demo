/**
 * Performance metrics dashboard overlay.
 *
 * Renders real-time global and per-stream performance metrics
 * as a DOM overlay on top of the video canvas. Updates at 1Hz.
 */

import type { MetricsCollector } from './metrics-collector';

/** FPS threshold for green color coding */
const FPS_GREEN = 25;

/** FPS threshold for yellow color coding (below this is red) */
const FPS_YELLOW = 15;

/**
 * DOM overlay dashboard that displays real-time performance metrics.
 *
 * Shows global metrics (total FPS, memory, render time, bandwidth)
 * at the top, followed by per-stream metrics (FPS, decode time,
 * dropped frames, queue size). FPS values are color-coded:
 * green (>25), yellow (15-25), red (<15).
 */
export class Dashboard {
  private readonly container: HTMLElement;
  private visible = true;
  private updateInterval: number | null = null;

  /**
   * Create a new Dashboard.
   * @param container - DOM element to render the dashboard into
   * @param metrics - MetricsCollector instance to read metrics from
   */
  constructor(
    container: HTMLElement,
    private readonly metrics: MetricsCollector
  ) {
    this.container = container;
  }

  /**
   * Start the 1Hz dashboard update loop.
   *
   * Immediately performs a first update, then schedules
   * recurring updates every 1000ms.
   */
  start(): void {
    if (this.updateInterval !== null) {
      return;
    }
    this.update();
    this.updateInterval = window.setInterval(() => this.update(), 1000);
  }

  /**
   * Stop the dashboard update loop.
   */
  stop(): void {
    if (this.updateInterval !== null) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Toggle dashboard visibility.
   *
   * When hidden, the dashboard container gets the "hidden" CSS class.
   * Updates continue in the background to avoid stale data on re-show.
   */
  toggle(): void {
    this.visible = !this.visible;
    if (this.visible) {
      this.container.classList.remove('hidden');
    } else {
      this.container.classList.add('hidden');
    }
  }

  /**
   * Render current metrics to the DOM.
   *
   * Rebuilds the entire dashboard content each update. This is
   * acceptable at 1Hz frequency and avoids complex diffing logic.
   */
  update(): void {
    const global = this.metrics.getGlobalMetrics();

    let html = '';

    // Global metrics section
    html += '<h3>Global</h3>';
    html += this.metricRow('Total FPS', `${global.totalFps}`, this.fpsClass(global.totalFps / Math.max(1, global.activeStreams)));
    html += this.metricRow('Active Streams', `${global.activeStreams}`);
    html += this.metricRow('Render Time', `${global.renderTimeMs.toFixed(2)} ms`);
    html += this.metricRow('Bandwidth', `${global.totalBandwidthMbps.toFixed(2)} Mbps`);
    html += this.metricRow('JS Heap', `${global.jsHeapUsedMB.toFixed(1)} MB`);
    html += this.metricRow('Longest Frame', `${global.longestFrameMs.toFixed(2)} ms`);

    // Per-stream metrics
    const streamIds = this.getStreamIds();
    for (const streamId of streamIds) {
      const sm = this.metrics.getStreamMetrics(streamId);
      html += `<div class="stream-section">`;
      html += `<h3>Stream ${sm.streamId}</h3>`;
      html += this.metricRow('FPS', `${sm.fps}`, this.fpsClass(sm.fps));
      html += this.metricRow('Decode', `${sm.decodeTimeMs.toFixed(2)} ms`);
      html += this.metricRow('Dropped', `${sm.droppedFrames}`);
      html += this.metricRow('Decoded', `${sm.decodedFrames}`);
      html += this.metricRow('Queue', `${sm.queueSize}`);
      html += this.metricRow('Bitrate', `${sm.bitrateKbps.toFixed(0)} kbps`);
      html += '</div>';
    }

    this.container.innerHTML = html;
  }

  /**
   * Build HTML for a single metric row.
   * @param label - Metric label
   * @param value - Metric value string
   * @param valueClass - Optional CSS class for color coding
   */
  private metricRow(label: string, value: string, valueClass = ''): string {
    const cls = valueClass ? ` class="metric-value ${valueClass}"` : ' class="metric-value"';
    return `<div class="metric-row"><span class="metric-label">${label}</span><span${cls}>${value}</span></div>`;
  }

  /**
   * Determine the CSS color class for an FPS value.
   * @param fps - Frames per second
   * @returns CSS class name: "green", "yellow", or "red"
   */
  private fpsClass(fps: number): string {
    if (fps > FPS_GREEN) return 'green';
    if (fps >= FPS_YELLOW) return 'yellow';
    return 'red';
  }

  /**
   * Get sorted list of stream IDs currently being tracked.
   * Reads from the metrics collector by checking known stream ranges.
   */
  private getStreamIds(): number[] {
    return this.metrics.getStreamIds();
  }
}
