/**
 * Message types for main thread ↔ stream worker communication.
 *
 * The worker owns the entire media pipeline: WebTransport connection,
 * H.264 demuxing, VideoDecoder, and WebGPU rendering to OffscreenCanvas.
 * The main thread handles DOM, UI, and layout.
 */

// ─── Main → Worker ─────────────────────────────────────────────

/** Initialize the WebTransport connection in the worker */
export interface InitMessage {
  type: 'init';
  wtUrl: string;
  certHashUrl: string;
}

/** Add a stream: transfer an OffscreenCanvas and start decode+render */
export interface AddStreamMessage {
  type: 'addStream';
  streamId: number;
  canvas: OffscreenCanvas;
  width: number;
  height: number;
}

/** Remove a stream and release its resources */
export interface RemoveStreamMessage {
  type: 'removeStream';
  streamId: number;
}

/** Notify the worker that a stream's canvas was resized */
export interface ResizeMessage {
  type: 'resize';
  streamId: number;
  width: number;
  height: number;
}

/** Shut down all streams and close the WebTransport connection */
export interface ShutdownMessage {
  type: 'shutdown';
}

/** Upscale mode: off (bilinear), cas (sharpen), fsr (edge-adaptive), a4k (CNN), tsr (temporal), spec (spectral), vqsr (vector-quantized), gen (ESRGAN), dlss (4K temporal+spatial) */
export type UpscaleMode = 'off' | 'cas' | 'fsr' | 'a4k' | 'tsr' | 'spec' | 'vqsr' | 'gen' | 'dlss';

/** Set GPU upscaling mode for all streams */
export interface SetUpscaleMessage {
  type: 'setUpscale';
  mode: UpscaleMode;
}

/** Normalized crop rectangle for zoom (0..1 coordinates within the video) */
export interface ZoomCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Set zoom crop for a specific stream (null = reset to full view) */
export interface SetZoomMessage {
  type: 'setZoom';
  streamId: number;
  crop: ZoomCrop | null;
}

/** Pause or resume a specific stream */
export interface PauseStreamMessage {
  type: 'pauseStream';
  streamId: number;
  paused: boolean;
}

/** Enable or disable comparison mode (original vs upscaled side-by-side) */
export interface SetCompareModeMessage {
  type: 'setCompareMode';
  enabled: boolean;
}

/** Add a companion renderer for side-by-side comparison (renders at mode=off) */
export interface AddCompanionMessage {
  type: 'addCompanion';
  primaryStreamId: number;
  companionStreamId: number;
  canvas: OffscreenCanvas;
  width: number;
  height: number;
}

/** Remove a companion renderer */
export interface RemoveCompanionMessage {
  type: 'removeCompanion';
  companionStreamId: number;
}

export type MainToWorkerMessage =
  | InitMessage
  | AddStreamMessage
  | RemoveStreamMessage
  | ResizeMessage
  | ShutdownMessage
  | SetUpscaleMessage
  | SetZoomMessage
  | PauseStreamMessage
  | SetCompareModeMessage
  | AddCompanionMessage
  | RemoveCompanionMessage;

// ─── Worker → Main ─────────────────────────────────────────────

/** WebTransport session successfully established */
export interface ConnectedMessage {
  type: 'connected';
}

/** An error occurred (optionally scoped to a specific stream) */
export interface ErrorMessage {
  type: 'error';
  streamId?: number;
  message: string;
}

/** Per-stream metrics snapshot */
export interface StreamMetricsUpdate {
  streamId: number;
  fps: number;
  decodedFrames: number;
  droppedFrames: number;
  queueSize: number;
  resolution: { width: number; height: number } | null;
  /** Average decode time per frame (ms) */
  decodeTimeMs: number;
  /** Average inter-frame interval (ms) */
  frameIntervalMs: number;
  /** Standard deviation of inter-frame intervals (ms) — jitter indicator */
  frameIntervalJitterMs: number;
  /** Count of stutters (frame interval > 2× median) since stream start */
  stutterCount: number;
  /** Estimated bitrate in kilobits per second */
  bitrateKbps: number;
}

/** Periodic metrics update for all active streams */
export interface MetricsMessage {
  type: 'metrics';
  streams: StreamMetricsUpdate[];
}

export type WorkerToMainMessage =
  | ConnectedMessage
  | ErrorMessage
  | MetricsMessage;
