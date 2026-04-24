/**
 * Message types for main thread ↔ stream worker communication.
 *
 * The worker owns the entire media pipeline: WebTransport connection,
 * H.264 demuxing, VideoDecoder, and WebGPU rendering to OffscreenCanvas.
 * The main thread handles DOM, UI, and layout.
 */

// ─── Main → Worker ─────────────────────────────────────────────

/** Initialize the transport connection in the worker */
export interface InitMessage {
  type: 'init';
  /** WebTransport URL — e.g. https://hostname:9001/streams */
  wtUrl: string;
  /** REST endpoint to fetch the TLS certificate hash for WebTransport pinning */
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

export type MainToWorkerMessage =
  | InitMessage
  | AddStreamMessage
  | RemoveStreamMessage
  | ResizeMessage
  | ShutdownMessage;

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
