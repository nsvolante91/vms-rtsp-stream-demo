/**
 * VMS Browser Prototype — Main Application Entry Point
 *
 * Bootstraps the video management system with per-stream canvas tiles
 * arranged in a CSS grid. The entire media pipeline (WebTransport, decode,
 * WebGPU render) runs in a dedicated Web Worker. The main thread handles
 * only DOM, layout, and UI.
 */

import { Logger } from './utils/logger';
import { detectDevice, isUpscaleModeAllowed, getHeavyUpscaleModes } from './utils/device';
import type { DeviceProfile } from './utils/device';
import { StreamTile } from './render/stream-tile';
import { MetricsCollector } from './perf/metrics-collector';
import { Dashboard } from './perf/dashboard';
import { BenchmarkRunner } from './perf/benchmark-runner';
import type { BenchmarkReport } from './perf/benchmark-runner';
import { Controls } from './ui/controls';
import { StreamOverlay } from './ui/stream-overlay';
import { suggestColumns } from './render/grid-layout';
import type { WorkerToMainMessage, MainToWorkerMessage } from './worker/messages';

/**
 * Derive server URLs based on the current hostname.
 *
 * When running on localhost/127.0.0.1, use the hardcoded 127.0.0.1 addresses
 * to avoid the macOS IPv6 issue. When accessed from another device on the LAN
 * (e.g. a phone), use the current hostname so the phone can reach the bridge server.
 */
function deriveServerUrls(): { apiUrl: string; wtUrl: string; wsUrl: string } {
  const host = window.location.hostname;
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const serverHost = isLocalhost ? '127.0.0.1' : host;
  const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';

  return {
    apiUrl: '/api',
    wtUrl: `https://${serverHost}:9001/streams`,
    wsUrl: `${wsProtocol}://${serverHost}:9000/ws`,
  };
}

const { apiUrl: API_URL, wtUrl: WT_URL, wsUrl: WS_URL } = deriveServerUrls();

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
  overlay: StreamOverlay;
}

/** Cached per-stream metrics from the worker's 1Hz updates */
interface WorkerStreamMetrics {
  fps: number;
  decodedFrames: number;
  droppedFrames: number;
  queueSize: number;
  resolution: { width: number; height: number } | null;
  decodeTimeMs: number;
  frameIntervalMs: number;
  frameIntervalJitterMs: number;
  stutterCount: number;
  bitrateKbps: number;
  renderDroppedFrames: number;
  resolutionTier: 'sd' | 'hd' | 'uhd';
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
  private columns = 1;
  private focusId: number | null = null;
  private nextStreamId = 1;
  private metricsInterval = 0;
  private metricsOverlayEnabled = false;

  // ── Device detection ──────────────────────────────────────────
  private readonly deviceProfile: DeviceProfile;
  private orientationQuery: MediaQueryList | null = null;

  // ── Comparison mode state ─────────────────────────────────────
  private compareMode = false;
  /** Offset added to primary streamId to derive companion streamId */
  private static readonly COMPANION_ID_OFFSET = 10000;
  /** Map primaryStreamId → { companionId, tile, overlay } */
  private readonly companions: Map<number, { companionId: number; tile: StreamTile; overlay: StreamOverlay }> = new Map();
  /** Saved column count to restore when exiting comparison mode */
  private savedColumns = 1;

  constructor() {
    this.metrics = new MetricsCollector();
    this.deviceProfile = detectDevice();

    const dashboardEl = document.getElementById('dashboard');
    if (!dashboardEl) {
      throw new Error('Dashboard element not found');
    }
    this.dashboard = new Dashboard(dashboardEl, this.metrics);

    if (this.deviceProfile.isMobile) {
      log.info(`Mobile device detected (maxStreams=${this.deviceProfile.maxStreams}, maxDPR=${this.deviceProfile.maxDPR}, gpu=${this.deviceProfile.gpuPowerPreference})`);
    }
  }

  /**
   * Initialize the application.
   *
   * Spawns the media worker, waits for WebTransport to connect,
   * sets up the CSS grid container, and auto-adds available streams.
   */
  async init(): Promise<void> {
    log.info('Initializing VMS Prototype (worker mode)');

    // Feature detection — distinguish insecure context from missing API
    if (typeof VideoDecoder === 'undefined') {
      if (!window.isSecureContext) {
        this.showError(
          'Insecure context — WebCodecs requires HTTPS.\n\n' +
          'You are accessing this page over plain HTTP. ' +
          'WebCodecs (VideoDecoder) is only available in secure contexts (HTTPS or localhost).\n\n' +
          'Access via https:// and accept the self-signed certificate warning.'
        );
      } else {
        this.showError(
          'Missing WebCodecs (VideoDecoder).\n\n' +
          'Your browser does not support the WebCodecs API. ' +
          'Please use Chrome 113+, Edge 113+, or Safari 17+.'
        );
      }
      return;
    }

    // Spawn worker and wait for WebTransport connection
    try {
      await this.initWorker();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.showError(`Connection failed: ${msg}`);
      return;
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
      () => this.dashboard.toggle(),
      (mode) => {
        if (!isUpscaleModeAllowed(mode, this.deviceProfile.isMobile)) {
          log.warn(`Upscale mode "${mode}" too heavy for mobile — ignoring`);
          return;
        }
        this.postWorker({ type: 'setUpscale', mode });
      },
      () => this.toggleMetricsOverlay(),
      () => this.resetMetrics(),
      () => this.toggleCompareMode(),
    );
    this.controls.init();

    // Disable heavy upscale options on mobile
    if (this.deviceProfile.isMobile) {
      const upscaleSelect = document.getElementById('upscale-select') as HTMLSelectElement | null;
      if (upscaleSelect) {
        const heavyModes = getHeavyUpscaleModes();
        for (const option of Array.from(upscaleSelect.options)) {
          if (heavyModes.has(option.value)) {
            option.disabled = true;
            option.textContent += ' (mobile: too heavy)';
          }
        }
      }
    }

    // Start dashboard
    this.dashboard.start();

    // Orientation change listener (auto-adjust columns on mobile)
    if (this.deviceProfile.isMobile) {
      this.orientationQuery = window.matchMedia('(orientation: portrait)');
      this.orientationQuery.addEventListener('change', () => this.handleOrientationChange());
    }

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
          log.info(`Worker connected via ${msg.transport}`);
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
      this.postWorker({
        type: 'init',
        wtUrl: WT_URL,
        wsUrl: WS_URL,
        certHashUrl: CERT_HASH_URL,
        gpuPowerPreference: this.deviceProfile.gpuPowerPreference,
      });
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
        log.info(`Worker reconnected via ${msg.transport}`);
        break;

      case 'error':
        if (msg.streamId !== undefined) {
          log.error(`Worker stream ${msg.streamId} error: ${msg.message}`);
        } else {
          log.error(`Worker error: ${msg.message}`);
        }
        break;

      case 'streamReady': {
        const entry = this.streams.get(msg.streamId);
        if (entry) {
          entry.tile.setWorkerRenderer(msg.renderer, msg.gpuFailReason);
          log.info(`Stream ${msg.streamId} renderer: ${msg.renderer}${msg.gpuFailReason ? ` (WebGPU failed: ${msg.gpuFailReason})` : ''}`);
        }
        break;
      }

      case 'metrics':
        // Update cached worker metrics and feed into MetricsCollector
        for (const update of msg.streams) {
          this.workerMetrics.set(update.streamId, {
            fps: update.fps,
            decodedFrames: update.decodedFrames,
            droppedFrames: update.droppedFrames,
            queueSize: update.queueSize,
            resolution: update.resolution,
            decodeTimeMs: update.decodeTimeMs,
            frameIntervalMs: update.frameIntervalMs,
            frameIntervalJitterMs: update.frameIntervalJitterMs,
            stutterCount: update.stutterCount,
            bitrateKbps: update.bitrateKbps,
            renderDroppedFrames: update.renderDroppedFrames,
            resolutionTier: update.resolutionTier,
          });

          // Feed queue size into MetricsCollector (used by dashboard)
          this.metrics.updateQueueSize(update.streamId, update.queueSize);

          // Sync decoded/dropped frame counts
          const data = this.metrics.getStreamMetrics(update.streamId);
          const newFrames = update.decodedFrames - data.decodedFrames;
          this.metrics.recordFrames(update.streamId, newFrames);

          // Feed bitrate bytes into MetricsCollector for export
          if (update.bitrateKbps > 0) {
            this.metrics.recordBytes(update.streamId, Math.round(update.bitrateKbps * 1000 / 8));
          }

          // Feed extended metrics for export
          this.metrics.updateExtendedMetrics(
            update.streamId,
            update.frameIntervalMs,
            update.frameIntervalJitterMs,
            update.stutterCount
          );
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

    // Enforce max streams on mobile
    if (this.streams.size >= this.deviceProfile.maxStreams) {
      log.warn(`Max streams (${this.deviceProfile.maxStreams}) reached`);
      return;
    }

    const streamId = this.nextStreamId++;
    log.info(`Adding stream ${streamId}`);

    const tile = new StreamTile(streamId);

    // Cap DPR on mobile to reduce GPU fill rate
    if (this.deviceProfile.maxDPR < (window.devicePixelRatio || 1)) {
      tile.setMaxDPR(this.deviceProfile.maxDPR);
    }

    this.gridContainer.appendChild(tile.element);

    // Click to toggle focus (only if it wasn't a drag-to-zoom)
    tile.element.addEventListener('click', () => {
      if (!tile.wasDrag) {
        this.toggleFocus(streamId);
      }
    });

    // Transfer the canvas to the worker for rendering
    const { canvas, width, height } = tile.transferCanvas();

    // Register resize callback to notify worker
    tile.onResize((w, h) => {
      this.postWorker({ type: 'resize', streamId, width: w, height: h });
    });

    // Register zoom callback
    tile.onZoom((sid, crop) => {
      this.postWorker({ type: 'setZoom', streamId: sid, crop });
      // Sync zoom to companion tile if in comparison mode
      const companion = this.companions.get(sid);
      if (companion) {
        this.postWorker({ type: 'setZoom', streamId: companion.companionId, crop });
        companion.tile.setZoomExternal(crop);
      }
    });

    // Register pause callback
    tile.onPause((sid, paused) => {
      this.postWorker({ type: 'pauseStream', streamId: sid, paused });
    });

    // Tell the worker to start decode+render for this stream
    this.postWorker(
      { type: 'addStream', streamId, canvas, width, height },
      [canvas]
    );

    // Create per-stream metrics overlay
    const overlay = new StreamOverlay(tile.element);
    if (this.metricsOverlayEnabled) {
      overlay.show();
    }

    this.streams.set(streamId, { tile, overlay });
    this.applyFocus();

    // If comparison mode is active, also create a companion tile
    if (this.compareMode) {
      this.addCompanionForStream(streamId);
    }
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
      // Remove companion first if it exists
      this.removeCompanionForStream(removeId);

      this.postWorker({ type: 'removeStream', streamId: removeId });
      entry.overlay.destroy();
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
      this.removeCompanionForStream(streamId);
      this.postWorker({ type: 'removeStream', streamId });
      entry.overlay.destroy();
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
   * Handle orientation change on mobile devices.
   * Auto-adjusts column count based on portrait/landscape.
   */
  private handleOrientationChange(): void {
    if (!this.deviceProfile.isMobile || !this.gridContainer) return;

    const containerAspect = this.gridContainer.clientWidth / this.gridContainer.clientHeight;
    const suggested = suggestColumns(this.streams.size, containerAspect, true);
    if (suggested !== null && suggested !== this.columns) {
      this.columns = suggested;
      this.updateGridCSS();
      log.info(`Orientation change → ${suggested} column(s)`);
    }
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

  /** Reset all collected metrics and analytics. */
  resetMetrics(): void {
    this.metrics.reset();
    log.info('Metrics reset');
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

        // Update per-stream overlay if enabled
        if (this.metricsOverlayEnabled) {
          entry.overlay.update({
            fps: wm.fps,
            resolution: resStr,
            droppedFrames: wm.droppedFrames,
            decodedFrames: wm.decodedFrames,
            decodeTimeMs: wm.decodeTimeMs,
            queueSize: wm.queueSize,
            frameIntervalMs: wm.frameIntervalMs,
            frameIntervalJitterMs: wm.frameIntervalJitterMs,
            stutterCount: wm.stutterCount,
            bitrateKbps: wm.bitrateKbps,
            renderDroppedFrames: wm.renderDroppedFrames,
            resolutionTier: wm.resolutionTier,
          });
        }
      }
    }
  }

  /**
   * Toggle per-stream metrics overlay on all tiles.
   */
  private toggleMetricsOverlay(): void {
    this.metricsOverlayEnabled = !this.metricsOverlayEnabled;
    for (const entry of this.streams.values()) {
      if (this.metricsOverlayEnabled) {
        entry.overlay.show();
      } else {
        entry.overlay.hide();
      }
    }
    log.info(`Metrics overlay ${this.metricsOverlayEnabled ? 'enabled' : 'disabled'}`);
  }

  // ── Comparison Mode ──────────────────────────────────────────

  /**
   * Toggle comparison mode: show original (no upscale) and upscaled side by side.
   */
  private toggleCompareMode(): void {
    this.compareMode = !this.compareMode;

    if (this.compareMode) {
      // Save current columns and force 2-column layout
      this.savedColumns = this.columns;
      this.columns = 2;
      this.focusId = null;
      this.updateGridCSS();

      // Create companion tiles for all existing streams
      for (const streamId of this.streams.keys()) {
        this.addCompanionForStream(streamId);
      }
    } else {
      // Remove all companion tiles
      for (const streamId of this.streams.keys()) {
        this.removeCompanionForStream(streamId);
      }

      // Restore saved column count
      this.columns = this.savedColumns;
      this.updateGridCSS();
    }

    this.applyFocus();
    log.info(`Comparison mode ${this.compareMode ? 'enabled' : 'disabled'}`);
  }

  /**
   * Create a companion tile for a primary stream (original, no upscaling).
   * The companion tile is inserted before the primary tile in the DOM
   * so it appears on the left in the 2-column grid.
   */
  private addCompanionForStream(primaryId: number): void {
    if (!this.workerReady || !this.gridContainer) return;
    if (this.companions.has(primaryId)) return;

    const companionId = primaryId + VMSApp.COMPANION_ID_OFFSET;
    const tile = new StreamTile(companionId);
    tile.setComparisonLabel('Original');

    // Insert companion tile before primary tile in DOM (left column)
    const primaryEntry = this.streams.get(primaryId);
    if (primaryEntry) {
      this.gridContainer.insertBefore(tile.element, primaryEntry.tile.element);
    } else {
      this.gridContainer.appendChild(tile.element);
    }

    // Transfer canvas to worker
    const { canvas, width, height } = tile.transferCanvas();

    // Register resize callback
    tile.onResize((w, h) => {
      this.postWorker({ type: 'resize', streamId: companionId, width: w, height: h });
    });

    // Register zoom callback — sync zoom to both tiles
    tile.onZoom((sid, crop) => {
      this.postWorker({ type: 'setZoom', streamId: sid, crop });
      // Also sync zoom to the primary tile
      this.postWorker({ type: 'setZoom', streamId: primaryId, crop });
      primaryEntry?.tile.setZoomExternal(crop);
    });

    // Register pause callback
    tile.onPause((sid, paused) => {
      this.postWorker({ type: 'pauseStream', streamId: sid, paused });
    });

    // Tell worker to create companion renderer
    this.postWorker(
      { type: 'addCompanion', primaryStreamId: primaryId, companionStreamId: companionId, canvas, width, height },
      [canvas]
    );

    const overlay = new StreamOverlay(tile.element);
    if (this.metricsOverlayEnabled) {
      overlay.show();
    }

    this.companions.set(primaryId, { companionId, tile, overlay });

    // Also update the primary tile label to show upscale mode
    if (primaryEntry) {
      primaryEntry.tile.setComparisonLabel('Upscaled');
    }

    log.info(`Companion tile ${companionId} created for stream ${primaryId}`);
  }

  /**
   * Remove the companion tile for a primary stream.
   */
  private removeCompanionForStream(primaryId: number): void {
    const companion = this.companions.get(primaryId);
    if (!companion) return;

    this.postWorker({ type: 'removeCompanion', companionStreamId: companion.companionId });
    companion.overlay.destroy();
    companion.tile.destroy();
    this.companions.delete(primaryId);

    // Clear the comparison label on the primary tile
    const primaryEntry = this.streams.get(primaryId);
    if (primaryEntry) {
      primaryEntry.tile.setComparisonLabel(null);
    }

    log.info(`Companion tile ${companion.companionId} removed for stream ${primaryId}`);
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
