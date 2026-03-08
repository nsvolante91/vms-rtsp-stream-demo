/**
 * Dedicated Web Worker — owns the entire media pipeline.
 *
 * Responsibilities:
 * - WebTransport connection to bridge server
 * - H.264 demuxing (Annex B → EncodedVideoChunk)
 * - WebCodecs VideoDecoder (hardware-accelerated)
 * - WebGPU rendering via OffscreenCanvas (importExternalTexture)
 * - 1 Hz metrics posting to main thread
 *
 * The main thread only handles DOM, layout, and UI.
 */

import { Logger } from '../utils/logger';
import { WTReceiver } from '../stream/wt-receiver';
import { StreamPipeline } from '../stream/stream-pipeline';
import type { StreamReceiver } from '../stream/stream-pipeline';
import {
  OffscreenRenderer,
  initWorkerGPU,
  type WorkerGPU,
  type GPUFailReason,
} from './offscreen-renderer';
import type {
  MainToWorkerMessage,
  StreamMetricsUpdate,
  UpscaleMode,
  ZoomCrop,
} from './messages';

const log = new Logger('StreamWorker');

// ─── Worker State ──────────────────────────────────────────────

let receiver: StreamReceiver | null = null;
let workerGPU: WorkerGPU | null = null;
let gpuFailReason: GPUFailReason | null = null;

interface StreamEntry {
  pipeline: StreamPipeline | null;
  renderer: OffscreenRenderer;
}

const streams = new Map<number, StreamEntry>();
let metricsTimer: ReturnType<typeof setInterval> | null = null;

/** Current upscale mode applied to all renderers */
let currentUpscaleMode: UpscaleMode = 'off';

/** Set of paused stream IDs */
const pausedStreams = new Set<number>();

// ─── Comparison Mode State ─────────────────────────────────────

/** Map primary streamId → companion streamId */
const companionMap = new Map<number, number>();
/** Set of companion stream IDs (render at mode=off, fed by cloned frames) */
const companionSet = new Set<number>();

// ─── rAF-Gated Rendering ───────────────────────────────────────

/**
 * Latest decoded frame per stream, awaiting the next rAF tick.
 * When a new frame arrives before rAF fires, the previous frame is
 * closed immediately (it was never displayed) to prevent GPU memory
 * buildup. This guarantees at most 1 GPU submit per stream per vsync.
 */
const pendingFrames = new Map<number, VideoFrame>();
let rafScheduled = false;

/** Batch-render all pending frames in a single rAF callback.
 *  Collects GPUCommandBuffers from all streams and submits once.
 *  Frames are closed AFTER submit because GPUExternalTexture references
 *  the VideoFrame data and becomes invalid if closed before submit. */
function renderLoop(): void {
  rafScheduled = false;
  const cmdBuffers: GPUCommandBuffer[] = [];
  const framesToClose: VideoFrame[] = [];
  for (const [streamId, frame] of pendingFrames) {
    const entry = streams.get(streamId);
    if (entry) {
      try {
        const cmdBuf = entry.renderer.encodeFrame(frame);
        if (cmdBuf) {
          cmdBuffers.push(cmdBuf);
        }
      } catch { /* frame will still be closed below */ }
    }
    // Always close the frame after encoding (whether it succeeded or not)
    framesToClose.push(frame);
  }
  pendingFrames.clear();
  // Single batched GPU submit for all streams
  if (cmdBuffers.length > 0 && workerGPU) {
    workerGPU.device.queue.submit(cmdBuffers);
  }
  // Close all frames AFTER submit to keep GPUExternalTextures valid
  for (const frame of framesToClose) {
    try { frame.close(); } catch { /* already closed */ }
  }
}

/** Schedule a rAF tick if not already scheduled */
function scheduleRender(): void {
  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(renderLoop);
  }
}

/** Queue a decoded frame for rendering on the next rAF tick */
function queueFrame(streamId: number, frame: VideoFrame): void {
  // If stream is paused, close the frame immediately to prevent GPU memory buildup
  if (pausedStreams.has(streamId)) {
    frame.close();
    return;
  }

  // If this primary stream has a companion, clone the frame for it
  const companionId = companionMap.get(streamId);
  if (companionId !== undefined && streams.has(companionId) && !pausedStreams.has(companionId)) {
    const clone = frame.clone();
    const prevCompanion = pendingFrames.get(companionId);
    if (prevCompanion) {
      prevCompanion.close();
    }
    pendingFrames.set(companionId, clone);
  }

  // Close previous un-rendered frame (superseded by this newer one)
  const prev = pendingFrames.get(streamId);
  if (prev) {
    prev.close();
  }
  pendingFrames.set(streamId, frame);
  scheduleRender();
}

// ─── Helpers ───────────────────────────────────────────────────

/** Post a typed message to the main thread */
function postMsg(msg: import('./messages').WorkerToMainMessage): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- worker global self.postMessage
  (self as any).postMessage(msg);
}

// ─── GPU Device Loss Recovery ──────────────────────────────────

/** Whether a GPU recovery is currently in progress */
let gpuRecoveryInProgress = false;

/**
 * Attempt to recover from GPU device loss.
 *
 * Requests a new adapter/device, re-creates pipeline/sampler/buffers,
 * and re-configures all active renderer canvas contexts.
 */
async function handleDeviceLost(info: GPUDeviceLostInfo): Promise<void> {
  if (gpuRecoveryInProgress) return;
  if (info.reason === 'destroyed') {
    // Intentional destroy (e.g., shutdown) — don't recover
    return;
  }

  gpuRecoveryInProgress = true;
  log.warn(`GPU device lost (reason: ${info.reason}), attempting recovery...`);

  try {
    const result = await initWorkerGPU(handleDeviceLost);
    if (!result.ok) {
      log.error(`GPU recovery failed: ${result.reason}`);
      postMsg({ type: 'error', message: 'GPU device lost and recovery failed' });
      return;
    }

    workerGPU = result.gpu;

    // Re-initialize all active renderers with the new GPU resources
    let recovered = 0;
    for (const [streamId, entry] of streams) {
      if (entry.renderer.reinitGPU(result.gpu)) {
        recovered++;
      } else {
        log.warn(`Failed to recover renderer for stream ${streamId}`);
      }
    }

    log.info(`GPU recovered: ${recovered}/${streams.size} renderers restored`);
  } catch (e) {
    log.error('GPU recovery failed', e);
    postMsg({ type: 'error', message: 'GPU device lost and recovery failed' });
  } finally {
    gpuRecoveryInProgress = false;
  }
}

/** Last decoded frame counts for FPS delta calculation */
const lastDecodedFrames = new Map<number, number>();

/** Start the 1 Hz metrics reporter */
function startMetricsReporter(): void {
  if (metricsTimer !== null) return;
  metricsTimer = setInterval(() => {
    const updates: StreamMetricsUpdate[] = [];
    for (const [streamId, entry] of streams) {
      // Skip companion renderers — they have no decode pipeline
      if (companionSet.has(streamId) || !entry.pipeline) continue;
      const m = entry.pipeline.metrics;
      const prev = lastDecodedFrames.get(streamId) ?? 0;
      const fps = m.decodedFrames - prev;
      lastDecodedFrames.set(streamId, m.decodedFrames);

      // Compute bitrate from consumed bytes
      const { bytes, elapsedMs } = entry.pipeline.consumeBytes();
      const elapsedSec = elapsedMs / 1000;
      const bitrateKbps = elapsedSec > 0 ? (bytes * 8) / elapsedSec / 1000 : 0;

      updates.push({
        streamId,
        fps,
        decodedFrames: m.decodedFrames,
        droppedFrames: m.droppedFrames,
        queueSize: m.queueSize,
        resolution: entry.pipeline.resolution,
        decodeTimeMs: m.decodeTimeMs,
        frameIntervalMs: m.frameIntervalMs,
        frameIntervalJitterMs: m.frameIntervalJitterMs,
        stutterCount: m.stutterCount,
        bitrateKbps,
      });
    }
    postMsg({ type: 'metrics', streams: updates });
  }, 1000);
}

/** Stop the metrics reporter */
function stopMetricsReporter(): void {
  if (metricsTimer !== null) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
}

// ─── Message Handlers ──────────────────────────────────────────

async function handleInit(wtUrl: string, certHashUrl: string, gpuPowerPreference?: GPUPowerPreference): Promise<void> {
  log.info('Initializing worker pipeline...');

  // 1. WebGPU (optional — Canvas2D fallback used if unavailable)
  const gpuResult = await initWorkerGPU(handleDeviceLost, gpuPowerPreference);
  if (gpuResult.ok) {
    workerGPU = gpuResult.gpu;
    log.info('WorkerGPU initialized');
  } else {
    gpuFailReason = gpuResult.reason;
    log.warn(`WebGPU unavailable in worker (${gpuFailReason}) — will use Canvas2D fallback`);
  }

  // 2. WebTransport
  const wt = new WTReceiver(wtUrl, certHashUrl);
  try {
    await wt.connect();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error('WebTransport connect failed', e);
    postMsg({ type: 'error', message: `WebTransport connect failed: ${msg}` });
    return;
  }
  receiver = wt;

  // 3. Start metrics reporter
  startMetricsReporter();

  postMsg({ type: 'connected' });
  log.info('Worker pipeline ready');
}

function handleAddStream(
  streamId: number,
  canvas: OffscreenCanvas,
  width: number,
  height: number
): void {
  if (!receiver) {
    log.warn(`Cannot add stream ${streamId}: worker not initialized`);
    postMsg({ type: 'error', streamId, message: 'Worker not initialized' });
    return;
  }

  if (streams.has(streamId)) {
    log.warn(`Stream ${streamId} already exists`);
    return;
  }

  // Create renderer — try WebGPU first, fall back to Canvas2D
  const renderer = new OffscreenRenderer(streamId, canvas);
  renderer.resize(width, height);
  renderer.setUpscaleMode(currentUpscaleMode);

  let renderOk = false;
  let streamGpuFailReason = gpuFailReason;
  if (workerGPU) {
    renderOk = renderer.initGPU(workerGPU);
    if (!renderOk) {
      streamGpuFailReason = 'getContext webgpu failed';
    }
  }
  if (!renderOk) {
    renderOk = renderer.initCanvas2D();
    if (!renderOk) {
      postMsg({ type: 'error', streamId, message: 'Failed to init rendering (WebGPU and Canvas2D both failed)' });
      return;
    }
  }

  // Create pipeline — decoded frames are queued for rAF-gated rendering
  const pipeline = new StreamPipeline(
    streamId,
    receiver,
    (frame: VideoFrame) => queueFrame(streamId, frame),
    (_sid, error) => {
      log.error(`Stream ${streamId} decode error: ${error.message}`);
      postMsg({ type: 'error', streamId, message: error.message });
    }
  );
  pipeline.start();

  streams.set(streamId, { pipeline, renderer });
  postMsg({
    type: 'streamReady', streamId,
    renderer: renderer.isCanvas2D ? 'canvas2d' : 'webgpu',
    gpuFailReason: renderer.isCanvas2D ? (streamGpuFailReason ?? 'unknown') : undefined,
  });
  log.info(`Stream ${streamId} added (${width}x${height}, ${renderer.isCanvas2D ? 'Canvas2D' : 'WebGPU'})`);
}

function handleRemoveStream(streamId: number): void {
  const entry = streams.get(streamId);
  if (!entry) return;

  // If this primary had a companion, remove it too
  const companionId = companionMap.get(streamId);
  if (companionId !== undefined) {
    handleRemoveCompanion(companionId);
  }

  entry.pipeline?.stop();
  entry.renderer.destroy();
  streams.delete(streamId);
  lastDecodedFrames.delete(streamId);
  pausedStreams.delete(streamId);
  // Close any pending frame for this stream
  const pending = pendingFrames.get(streamId);
  if (pending) {
    pending.close();
    pendingFrames.delete(streamId);
  }
  log.info(`Stream ${streamId} removed`);
}

function handleResize(streamId: number, width: number, height: number): void {
  const entry = streams.get(streamId);
  if (entry) {
    entry.renderer.resize(width, height);
  }
}

function handleShutdown(): void {
  log.info('Shutting down worker...');
  stopMetricsReporter();
  // Close all pending frames
  for (const frame of pendingFrames.values()) {
    frame.close();
  }
  pendingFrames.clear();
  for (const [streamId, entry] of streams) {
    if (!companionSet.has(streamId)) {
      entry.pipeline?.stop();
    }
    entry.renderer.destroy();
    log.info(`Stream ${streamId} cleaned up`);
  }
  streams.clear();
  companionMap.clear();
  companionSet.clear();

  receiver = null;
  workerGPU = null;
  log.info('Worker shut down');
}

// ─── Message Dispatch ──────────────────────────────────────────

self.onmessage = (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init':
      handleInit(msg.wtUrl, msg.certHashUrl, msg.gpuPowerPreference).catch((err) => {
        log.error('Init failed', err);
        postMsg({ type: 'error', message: `Init failed: ${err}` });
      });
      break;

    case 'addStream':
      handleAddStream(msg.streamId, msg.canvas, msg.width, msg.height);
      break;

    case 'removeStream':
      handleRemoveStream(msg.streamId);
      break;

    case 'resize':
      handleResize(msg.streamId, msg.width, msg.height);
      break;

    case 'shutdown':
      handleShutdown();
      break;

    case 'setUpscale':
      currentUpscaleMode = msg.mode;
      for (const [sid, entry] of streams) {
        // Skip companion renderers — they always stay at mode=off
        if (companionSet.has(sid)) continue;
        entry.renderer.setUpscaleMode(msg.mode);
      }
      log.info(`Upscale mode set to ${msg.mode}`);
      break;

    case 'setZoom': {
      const zoomEntry = streams.get(msg.streamId);
      if (zoomEntry) {
        zoomEntry.renderer.setZoom(msg.crop);
        log.info(`Stream ${msg.streamId} zoom ${msg.crop ? `set to (${msg.crop.x.toFixed(2)},${msg.crop.y.toFixed(2)},${msg.crop.w.toFixed(2)},${msg.crop.h.toFixed(2)})` : 'reset'}`);
      }
      break;
    }

    case 'pauseStream': {
      if (msg.paused) {
        pausedStreams.add(msg.streamId);
      } else {
        pausedStreams.delete(msg.streamId);
      }
      log.info(`Stream ${msg.streamId} ${msg.paused ? 'paused' : 'resumed'}`);
      break;
    }

    case 'addCompanion':
      handleAddCompanion(msg.primaryStreamId, msg.companionStreamId, msg.canvas, msg.width, msg.height);
      break;

    case 'removeCompanion':
      handleRemoveCompanion(msg.companionStreamId);
      break;

    case 'setCompareMode':
      // State is managed on the main thread; worker just receives
      // addCompanion/removeCompanion messages. This is a no-op.
      break;

    default:
      log.warn('Unknown message type', msg);
  }
};

// ─── Companion Handlers ────────────────────────────────────────

function handleAddCompanion(
  primaryStreamId: number,
  companionStreamId: number,
  canvas: OffscreenCanvas,
  width: number,
  height: number
): void {
  if (streams.has(companionStreamId)) {
    log.warn(`Companion ${companionStreamId} already exists`);
    return;
  }

  // Create renderer — always at mode=off (no upscaling)
  const renderer = new OffscreenRenderer(companionStreamId, canvas);
  renderer.resize(width, height);
  renderer.setUpscaleMode('off');

  let renderOk = false;
  if (workerGPU) {
    renderOk = renderer.initGPU(workerGPU);
  }
  if (!renderOk) {
    renderOk = renderer.initCanvas2D();
    if (!renderOk) {
      postMsg({ type: 'error', streamId: companionStreamId, message: 'Failed to init rendering for companion' });
      return;
    }
  }

  // Companion has no pipeline — it receives cloned frames via queueFrame
  // Store with a null pipeline sentinel
  streams.set(companionStreamId, { pipeline: null, renderer });
  companionMap.set(primaryStreamId, companionStreamId);
  companionSet.add(companionStreamId);
  postMsg({ type: 'streamReady', streamId: companionStreamId, renderer: renderer.isCanvas2D ? 'canvas2d' : 'webgpu' });
  log.info(`Companion ${companionStreamId} added for primary ${primaryStreamId} (${width}x${height})`);
}

function handleRemoveCompanion(companionStreamId: number): void {
  const entry = streams.get(companionStreamId);
  if (!entry) return;

  entry.renderer.destroy();
  streams.delete(companionStreamId);
  companionSet.delete(companionStreamId);

  // Remove from companionMap
  for (const [primary, companion] of companionMap) {
    if (companion === companionStreamId) {
      companionMap.delete(primary);
      break;
    }
  }

  // Close any pending frame
  const pending = pendingFrames.get(companionStreamId);
  if (pending) {
    pending.close();
    pendingFrames.delete(companionStreamId);
  }

  log.info(`Companion ${companionStreamId} removed`);
}

log.info('Stream worker loaded');
