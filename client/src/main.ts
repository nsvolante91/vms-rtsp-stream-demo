/**
 * VMS Browser Prototype — Main Application Entry Point
 *
 * Bootstraps the video management system with per-stream canvas tiles
 * arranged in a CSS grid. The entire media pipeline (WebTransport, decode,
 * WebGPU render) runs in a dedicated Web Worker. The main thread handles
 * only DOM, layout, and UI.
 */

import { Logger } from './utils/logger';
import { StreamTile } from './render/stream-tile';
import { MetricsCollector } from './perf/metrics-collector';
import { Dashboard } from './perf/dashboard';
import { BenchmarkRunner } from './perf/benchmark-runner';
import type { BenchmarkReport } from './perf/benchmark-runner';
import { Controls } from './ui/controls';
import type { WorkerToMainMessage, MainToWorkerMessage } from './worker/messages';

/**
 * REST API base URL — relative, proxied by the Vite dev server.
 * The Vite server rewrites /api/* → bridge:9000/* over plain HTTP internally,
 * so the browser never sees the plain HTTP origin and there are no mixed-content
 * or certificate trust issues. Works identically for local and remote access.
 */
const API_URL = '/api';

/**
 * WebTransport URL — uses the same hostname the page was served from so the
 * bridge server's TLS certificate (which lists that host in its SAN) is valid.
 * Falls back to localhost when running locally.
 */
const WT_URL = `https://${window.location.hostname}:9001/streams`;

/** REST endpoint for certificate hash (for WebTransport pinning) */
const CERT_HASH_URL = `${API_URL}/cert-hash`;

/** HTTP endpoint for available streams */
const STREAMS_URL = `${API_URL}/streams`;

/** Maximum number of streams to auto-add on startup */
const AUTO_ADD_MAX = 1;

const log = new Logger('VMSApp');

/** A stream's tile managed on the main thread */
interface StreamEntry {
  tile: StreamTile;
}

/** Cached per-stream metrics from the worker's 1Hz updates */
interface WorkerStreamMetrics {
  fps: number;
  decodedFrames: number;
  droppedFrames: number;
  queueSize: number;
  resolution: { width: number; height: number } | null;
}

/**
 * Main VMS application controller.
 *
 * Manages per-stream tiles in a CSS grid layout. The entire media pipeline
 * (WebTransport ↔ decode ↔ WebGPU render) runs in a dedicated worker.
 * Main thread only handles DOM manipulation and UI events.
 */
class VMSApp {
  private worker: Worker | null = null;
  private workerReady = false;
  private readonly streams: Map<number, StreamEntry> = new Map();
  private readonly workerMetrics: Map<number, WorkerStreamMetrics> = new Map();
  private readonly metrics: MetricsCollector;
  private readonly dashboard: Dashboard;
  private controls: Controls | null = null;
  private benchmarkRunner: BenchmarkRunner | null = null;
  private gridContainer: HTMLDivElement | null = null;
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
   * Spawns the media worker, waits for WebTransport to connect,
   * sets up the CSS grid container, and auto-adds available streams.
   */
  async init(): Promise<void> {
    log.info('Initializing VMS Prototype (worker mode)');

    // Feature detection
    if (typeof VideoDecoder === 'undefined') {
      this.showError('Missing WebCodecs (VideoDecoder). Please use Chrome 113+ or Safari 17+.');
      return;
    }

    // Spawn worker and wait for WebTransport connection
    await this.initWorker();

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

    // 1Hz polling for tile label updates (uses cached worker metrics)
    this.metricsInterval = window.setInterval(() => this.updateMetrics(), 1000);

    // Fetch available streams and auto-add
    await this.fetchAndAutoAddStreams();

    log.info('VMS Prototype initialized (worker mode)');
  }

  /**
   * Spawn the stream worker and wait for WebTransport connection.
   */
  private initWorker(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.worker = new Worker(
        new URL('./worker/stream-worker.ts', import.meta.url),
        { type: 'module' }
      );

      const onMessage = (e: MessageEvent<WorkerToMainMessage>) => {
        const msg = e.data;
        if (msg.type === 'connected') {
          this.workerReady = true;
          log.info('Worker connected (WebTransport ready)');
          resolve();
        } else if (msg.type === 'error') {
          log.error(`Worker init error: ${msg.message}`);
          reject(new Error(msg.message));
        }
      };

      // Temporary handler for init phase
      this.worker.addEventListener('message', onMessage);
      this.worker.addEventListener('error', (err) => {
        log.error('Worker error', err);
        reject(new Error('Worker failed to load'));
      }, { once: true });

      // Switch to the steady-state handler after init completes
      const initDone = () => {
        this.worker?.removeEventListener('message', onMessage);
        this.worker?.addEventListener('message', (e: MessageEvent<WorkerToMainMessage>) => {
          this.handleWorkerMessage(e.data);
        });
      };

      // Resolve/reject both trigger switching to steady-state
      const origResolve = resolve;
      const origReject = reject;
      resolve = (v) => { initDone(); origResolve(v); };
      reject = (e) => { initDone(); origReject(e); };

      // Send init message to worker
      this.postWorker({ type: 'init', wtUrl: WT_URL, certHashUrl: CERT_HASH_URL });
    });
  }

  /**
   * Handle messages from the worker (steady-state).
   */
  private handleWorkerMessage(msg: WorkerToMainMessage): void {
    switch (msg.type) {
      case 'connected':
        // Reconnection
        this.workerReady = true;
        log.info('Worker reconnected');
        break;

      case 'error':
        if (msg.streamId !== undefined) {
          log.error(`Worker stream ${msg.streamId} error: ${msg.message}`);
        } else {
          log.error(`Worker error: ${msg.message}`);
        }
        break;

      case 'metrics':
        // Update cached worker metrics and feed into MetricsCollector
        for (const update of msg.streams) {
          this.workerMetrics.set(update.streamId, update);

          // Feed queue size into MetricsCollector (used by dashboard)
          this.metrics.updateQueueSize(update.streamId, update.queueSize);

          // Sync decoded/dropped frame counts
          const data = this.metrics.getStreamMetrics(update.streamId);
          const newFrames = update.decodedFrames - data.decodedFrames;
          for (let i = 0; i < newFrames; i++) {
            this.metrics.recordFrame(update.streamId);
          }
        }
        break;
    }
  }

  /**
   * Post a message to the worker with proper typing.
   */
  private postWorker(msg: MainToWorkerMessage, transfer?: Transferable[]): void {
    if (!this.worker) {
      log.warn('Worker not available');
      return;
    }
    if (transfer) {
      this.worker.postMessage(msg, transfer);
    } else {
      this.worker.postMessage(msg);
    }
  }

  /**
   * Add a new video stream.
   *
   * Creates a StreamTile (canvas + label), appends it to the CSS grid,
   * transfers the canvas to the worker, and tells the worker to start
   * decode+render for this stream.
   */
  async addStream(): Promise<void> {
    if (!this.workerReady || !this.gridContainer) {
      log.warn('Not ready to add stream');
      return;
    }

    const streamId = this.nextStreamId++;
    log.info(`Adding stream ${streamId}`);

    const tile = new StreamTile(streamId);
    this.gridContainer.appendChild(tile.element);

    // Click to toggle focus
    tile.element.addEventListener('click', () => this.toggleFocus(streamId));

    // Transfer the canvas to the worker for rendering
    const { canvas, width, height } = tile.transferCanvas();

    // Register resize callback to notify worker
    tile.onResize((w, h) => {
      this.postWorker({ type: 'resize', streamId, width: w, height: h });
    });

    // Tell the worker to start decode+render for this stream
    this.postWorker(
      { type: 'addStream', streamId, canvas, width, height },
      [canvas]
    );

    this.streams.set(streamId, { tile });
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
      this.postWorker({ type: 'removeStream', streamId: removeId });
      entry.tile.destroy();
      this.streams.delete(removeId);
      this.workerMetrics.delete(removeId);
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
      this.postWorker({ type: 'removeStream', streamId });
      entry.tile.destroy();
      this.workerMetrics.delete(streamId);
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
      'WebGPU Worker (importExternalTexture)'
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

  /**
   * Update tile labels using cached worker metrics (called at 1Hz).
   */
  private updateMetrics(): void {
    for (const [streamId, entry] of this.streams) {
      const wm = this.workerMetrics.get(streamId);
      if (wm) {
        const resStr = wm.resolution ? `${wm.resolution.width}x${wm.resolution.height}` : '...';
        entry.tile.updateLabel(resStr, wm.fps);
      }
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
