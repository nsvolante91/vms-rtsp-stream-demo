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
} from './offscreen-renderer';
import type {
  MainToWorkerMessage,
  StreamMetricsUpdate,
} from './messages';

const log = new Logger('StreamWorker');

// ─── Worker State ──────────────────────────────────────────────

let receiver: StreamReceiver | null = null;
let workerGPU: WorkerGPU | null = null;

interface StreamEntry {
  pipeline: StreamPipeline;
  renderer: OffscreenRenderer;
}

const streams = new Map<number, StreamEntry>();
let metricsTimer: ReturnType<typeof setInterval> | null = null;

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
 *  Collects GPUCommandBuffers from all streams and submits once. */
function renderLoop(): void {
  rafScheduled = false;
  const cmdBuffers: GPUCommandBuffer[] = [];
  for (const [streamId, frame] of pendingFrames) {
    const entry = streams.get(streamId);
    if (entry) {
      const cmdBuf = entry.renderer.encodeFrame(frame);
      if (cmdBuf) {
        cmdBuffers.push(cmdBuf);
      }
    } else {
      frame.close();
    }
  }
  pendingFrames.clear();
  // Single batched GPU submit for all streams
  if (cmdBuffers.length > 0 && workerGPU) {
    workerGPU.device.queue.submit(cmdBuffers);
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
    const newGPU = await initWorkerGPU(handleDeviceLost);
    if (!newGPU) {
      log.error('GPU recovery failed: could not re-initialize WebGPU');
      postMsg({ type: 'error', message: 'GPU device lost and recovery failed' });
      return;
    }

    workerGPU = newGPU;

    // Re-initialize all active renderers with the new GPU resources
    let recovered = 0;
    for (const [streamId, entry] of streams) {
      if (entry.renderer.reinitGPU(newGPU)) {
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
      const m = entry.pipeline.metrics;
      const prev = lastDecodedFrames.get(streamId) ?? 0;
      const fps = m.decodedFrames - prev;
      lastDecodedFrames.set(streamId, m.decodedFrames);

      updates.push({
        streamId,
        fps,
        decodedFrames: m.decodedFrames,
        droppedFrames: m.droppedFrames,
        queueSize: m.queueSize,
        resolution: entry.pipeline.resolution,
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

async function handleInit(wtUrl: string, certHashUrl: string): Promise<void> {
  log.info('Initializing worker pipeline...');

  // 1. WebGPU
  workerGPU = await initWorkerGPU(handleDeviceLost);
  if (workerGPU) {
    log.info('WorkerGPU initialized');
  } else {
    log.warn('WebGPU unavailable in worker');
    postMsg({ type: 'error', message: 'WebGPU not available in worker' });
    return;
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
  if (!receiver || !workerGPU) {
    log.warn(`Cannot add stream ${streamId}: worker not initialized`);
    postMsg({ type: 'error', streamId, message: 'Worker not initialized' });
    return;
  }

  if (streams.has(streamId)) {
    log.warn(`Stream ${streamId} already exists`);
    return;
  }

  // Create renderer
  const renderer = new OffscreenRenderer(streamId, canvas);
  renderer.resize(width, height);
  const gpuOk = renderer.initGPU(workerGPU);
  if (!gpuOk) {
    postMsg({ type: 'error', streamId, message: 'Failed to init WebGPU on OffscreenCanvas' });
    return;
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
  log.info(`Stream ${streamId} added (${width}x${height})`);
}

function handleRemoveStream(streamId: number): void {
  const entry = streams.get(streamId);
  if (!entry) return;

  entry.pipeline.stop();
  entry.renderer.destroy();
  streams.delete(streamId);
  lastDecodedFrames.delete(streamId);
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
    entry.pipeline.stop();
    entry.renderer.destroy();
    log.info(`Stream ${streamId} cleaned up`);
  }
  streams.clear();

  receiver = null;
  workerGPU = null;
  log.info('Worker shut down');
}

// ─── Message Dispatch ──────────────────────────────────────────

self.onmessage = (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init':
      handleInit(msg.wtUrl, msg.certHashUrl).catch((err) => {
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

    default:
      log.warn('Unknown message type', msg);
  }
};

log.info('Stream worker loaded');
