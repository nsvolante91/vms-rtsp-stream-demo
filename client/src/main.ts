/**
 * VMS Browser Prototype — Main Application Entry Point
 *
 * Bootstraps the video management system with per-stream canvas tiles
 * arranged in a CSS grid. Each stream has its own decode pipeline that
 * draws directly to its canvas via the decoder output callback.
 */

import { Logger } from './utils/logger';
import { WTReceiver } from './stream/wt-receiver';
import { WSReceiver } from './stream/ws-receiver';
import { StreamPipeline } from './stream/stream-pipeline';
import type { StreamReceiver } from './stream/stream-pipeline';
import { StreamTile, initSharedGPU, type SharedGPU } from './render/stream-tile';
import { MetricsCollector } from './perf/metrics-collector';
import { Dashboard } from './perf/dashboard';
import { BenchmarkRunner } from './perf/benchmark-runner';
import type { BenchmarkReport } from './perf/benchmark-runner';
import { Controls } from './ui/controls';

/**
 * REST API base URL.
 * Uses 127.0.0.1 instead of 'localhost' because macOS resolves localhost
 * to IPv6 (::1) first, but the QUIC/UDP server binds to IPv4 (0.0.0.0).
 * Chrome's Happy Eyeballs prefers IPv6 and fails when no UDP listener exists on ::1.
 */
const API_URL = 'http://127.0.0.1:9000';

/**
 * WebTransport bridge server URL.
 * Must use 127.0.0.1 to match the server's IPv4 UDP socket binding.
 * The server's TLS certificate includes IP:127.0.0.1 in its SAN.
 */
const WT_URL = 'https://127.0.0.1:9001/streams';

/** REST endpoint for certificate hash (for WebTransport pinning) */
const CERT_HASH_URL = `${API_URL}/cert-hash`;

/** HTTP endpoint for available streams */
const STREAMS_URL = `${API_URL}/streams`;

/** WebSocket fallback URL (same HTTP server, /ws path) */
const WS_URL = `ws://127.0.0.1:9000/ws`;

/** Maximum number of streams to auto-add on startup */
const AUTO_ADD_MAX = 1;

const log = new Logger('VMSApp');

/** A stream's tile and decode pipeline, managed as a pair */
interface StreamEntry {
  pipeline: StreamPipeline;
  tile: StreamTile;
}

/**
 * Main VMS application controller.
 *
 * Manages per-stream tiles in a CSS grid layout. Each tile has its own
 * canvas and decode pipeline. No shared render loop — each decoder
 * draws directly to its canvas when a frame is decoded.
 */
class VMSApp {
  private receiver: StreamReceiver | null = null;
  private readonly streams: Map<number, StreamEntry> = new Map();
  private readonly metrics: MetricsCollector;
  private readonly dashboard: Dashboard;
  private controls: Controls | null = null;
  private benchmarkRunner: BenchmarkRunner | null = null;
  private gridContainer: HTMLDivElement | null = null;
  private sharedGPU: SharedGPU | null = null;
  private columns = 4;
  private focusId: number | null = null;
  private nextStreamId = 1;
  private metricsInterval = 0;

  constructor() {
    this.metrics = new MetricsCollector();

    const dashboardEl = document.getElementById('dashboard');
    if (!dashboardEl) {
      throw new Error('Dashboard element not found');
    }
    this.dashboard = new Dashboard(dashboardEl, this.metrics);
  }

  /**
   * Initialize the application.
   *
   * Performs feature detection, sets up the CSS grid container,
   * connects the WebSocket, and auto-adds available streams.
   */
  async init(): Promise<void> {
    log.info('Initializing VMS Prototype');

    // Feature detection
    if (typeof VideoDecoder === 'undefined') {
      this.showError('Missing WebCodecs (VideoDecoder). Please use Chrome 113+ or Safari 17+.');
      return;
    }

    // Connect transport: prefer WebTransport, fall back to WebSocket
    if (typeof WebTransport !== 'undefined') {
      log.info('WebTransport available — using QUIC transport');
      const wt = new WTReceiver(WT_URL, CERT_HASH_URL);
      await wt.connect();
      this.receiver = wt;
    } else {
      log.warn('WebTransport unavailable — falling back to WebSocket transport');
      const ws = new WSReceiver(WS_URL);
      ws.connect();
      this.receiver = ws;
    }

    // Initialize shared WebGPU resources (shared device, pipeline, sampler)
    this.sharedGPU = await initSharedGPU();
    if (this.sharedGPU) {
      log.info('WebGPU initialized — using zero-copy importExternalTexture rendering');
    } else {
      log.warn('WebGPU unavailable — falling back to Canvas2D rendering');
    }

    this.gridContainer = document.getElementById('video-grid') as HTMLDivElement | null;
    if (!this.gridContainer) {
      this.showError('Grid container element not found');
      return;
    }
    this.updateGridCSS();

    // Set up UI controls
    this.controls = new Controls(
      (columns) => this.setLayout(columns),
      () => this.addStream(),
      () => this.removeStream(),
      () => this.runBenchmark(),
      () => this.exportMetrics(),
      () => this.dashboard.toggle()
    );
    this.controls.init();

    // Start dashboard
    this.dashboard.start();

    // 1Hz polling for queue size metrics and tile label updates
    this.metricsInterval = window.setInterval(() => this.updateMetrics(), 1000);

    // Fetch available streams and auto-add
    await this.fetchAndAutoAddStreams();

    log.info('VMS Prototype initialized');
  }

  /**
   * Add a new video stream.
   *
   * Creates a StreamTile (canvas + label), appends it to the CSS grid,
   * and starts a StreamPipeline that draws directly to the tile's canvas.
   */
  async addStream(): Promise<void> {
    if (!this.receiver || !this.gridContainer) {
      log.warn('Not ready to add stream');
      return;
    }

    const streamId = this.nextStreamId++;
    log.info(`Adding stream ${streamId}`);

    const tile = new StreamTile(streamId);
    this.gridContainer.appendChild(tile.element);

    // Initialize per-tile WebGPU rendering (falls back to Canvas2D)
    if (this.sharedGPU) {
      tile.initGPU(this.sharedGPU);
    }

    // Click to toggle focus
    tile.element.addEventListener('click', () => this.toggleFocus(streamId));

    const pipeline = new StreamPipeline(
      streamId,
      this.receiver,
      (frame: VideoFrame) => {
        tile.drawFrame(frame);
        this.metrics.recordFrame(streamId);
      },
      (sid, error) => {
        log.error(`Stream ${sid} error: ${error.message}`);
      }
    );

    pipeline.start();
    this.streams.set(streamId, { pipeline, tile });
    this.applyFocus();
  }

  /**
   * Remove the most recently added stream.
   */
  removeStream(): void {
    if (this.streams.size === 0) {
      return;
    }

    const streamIds = Array.from(this.streams.keys()).sort((a, b) => a - b);
    const removeId = streamIds[streamIds.length - 1];

    const entry = this.streams.get(removeId);
    if (entry) {
      entry.pipeline.stop();
      entry.tile.destroy();
      this.streams.delete(removeId);
      this.metrics.removeStream(removeId);
    }

    if (this.focusId === removeId) {
      this.focusId = null;
    }

    this.applyFocus();
    log.info(`Removed stream ${removeId}`);
  }

  /**
   * Remove all active streams.
   */
  removeAllStreams(): void {
    for (const [streamId, entry] of this.streams) {
      entry.pipeline.stop();
      entry.tile.destroy();
      this.metrics.removeStream(streamId);
    }
    this.streams.clear();
    this.focusId = null;
    log.info('All streams removed');
  }

  /**
   * Change the grid layout column count.
   * @param columns - Number of columns (1, 2, 3, or 4)
   */
  setLayout(columns: number): void {
    this.columns = columns;
    this.focusId = null;
    this.updateGridCSS();
    this.applyFocus();
    log.info(`Layout set to ${columns} columns`);
  }

  /**
   * Toggle focus on a stream tile.
   *
   * When focused, only the focused tile is visible and it fills the grid.
   * Clicking the focused tile again returns to the grid view.
   */
  toggleFocus(streamId: number): void {
    this.focusId = this.focusId === streamId ? null : streamId;
    this.applyFocus();
  }

  /**
   * Run the automated progressive benchmark.
   */
  async runBenchmark(): Promise<void> {
    if (this.benchmarkRunner?.isRunning) {
      this.benchmarkRunner.abort();
      return;
    }

    this.benchmarkRunner = new BenchmarkRunner(
      () => this.addStream(),
      () => this.removeAllStreams(),
      this.metrics,
      this.sharedGPU ? 'WebGPU (importExternalTexture)' : 'Canvas2D (per-tile)'
    );

    log.info('Starting benchmark...');
    try {
      const report: BenchmarkReport = await this.benchmarkRunner.run();
      log.info('Benchmark complete', report);
      this.downloadJSON('benchmark-report.json', JSON.stringify(report, null, 2));
    } catch (e) {
      log.error('Benchmark failed', e);
    }
  }

  /**
   * Export current performance metrics as a JSON file download.
   */
  exportMetrics(): void {
    const json = this.metrics.exportJSON();
    this.downloadJSON('vms-metrics.json', json);
    log.info('Metrics exported');
  }

  /** Update the CSS grid-template-columns property */
  private updateGridCSS(): void {
    if (!this.gridContainer) return;
    this.gridContainer.style.gridTemplateColumns = `repeat(${this.columns}, 1fr)`;
  }

  /**
   * Apply focus visibility: when a tile is focused, hide all others
   * and switch to single-column layout. When unfocused, restore grid.
   */
  private applyFocus(): void {
    for (const [id, entry] of this.streams) {
      if (this.focusId === null) {
        entry.tile.element.style.display = '';
        entry.tile.element.classList.remove('focused');
      } else if (id === this.focusId) {
        entry.tile.element.style.display = '';
        entry.tile.element.classList.add('focused');
      } else {
        entry.tile.element.style.display = 'none';
        entry.tile.element.classList.remove('focused');
      }
    }

    if (!this.gridContainer) return;
    if (this.focusId !== null) {
      this.gridContainer.style.gridTemplateColumns = '1fr';
    } else {
      this.gridContainer.style.gridTemplateColumns = `repeat(${this.columns}, 1fr)`;
    }
  }

  /** Poll pipeline metrics and update tile labels (called at 1Hz) */
  private updateMetrics(): void {
    for (const [streamId, entry] of this.streams) {
      const pipelineMetrics = entry.pipeline.metrics;
      this.metrics.updateQueueSize(streamId, pipelineMetrics.queueSize);

      // Update the tile's label overlay
      const res = entry.pipeline.resolution;
      const sm = this.metrics.getStreamMetrics(streamId);
      const resStr = res ? `${res.width}x${res.height}` : '...';
      entry.tile.updateLabel(resStr, sm.fps);
    }
  }

  /**
   * Fetch available streams from the bridge server and auto-add up to AUTO_ADD_MAX.
   */
  private async fetchAndAutoAddStreams(): Promise<void> {
    try {
      const response = await fetch(STREAMS_URL);
      if (!response.ok) {
        log.warn(`Failed to fetch streams: ${response.status}`);
        return;
      }

      const data = await response.json() as { streams?: Array<{ id: number }> } | number[];

      let availableIds: number[];
      if (Array.isArray(data)) {
        availableIds = data.map(Number);
      } else if (data.streams) {
        availableIds = data.streams.map(s => s.id);
      } else {
        availableIds = [];
      }

      const autoAddCount = Math.min(availableIds.length, AUTO_ADD_MAX);
      log.info(`Found ${availableIds.length} streams, auto-adding ${autoAddCount}`);

      for (let i = 0; i < autoAddCount; i++) {
        await this.addStream();
      }
    } catch (e) {
      log.warn('Could not fetch available streams (bridge server may not be running)', e);
    }
  }

  /**
   * Show an error overlay on the page.
   * @param message - Error message to display
   */
  private showError(message: string): void {
    const overlay = document.getElementById('error-overlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      overlay.innerHTML = `<h2>Error</h2><p>${message.replace(/\n/g, '<br>')}</p>`;
    }
    log.error(message);
  }

  /**
   * Trigger a JSON file download in the browser.
   * @param filename - Suggested filename for the download
   * @param content - JSON string content
   */
  private downloadJSON(filename: string, content: string): void {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}

// Bootstrap the application
const app = new VMSApp();
app.init().catch((e) => {
  log.error('Failed to initialize', e);
});
