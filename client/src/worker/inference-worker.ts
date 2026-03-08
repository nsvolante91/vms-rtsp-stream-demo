/**
 * Dedicated ML inference worker for YOLO object detection.
 *
 * Runs ONNX Runtime Web with WebGPU backend (or WASM fallback)
 * on transferred VideoFrames. Performs YOLOv8 inference at ~6 FPS
 * independently from the render pipeline.
 *
 * Communication with the stream worker:
 * - Receives: VideoFrame (transferable, zero-copy) + streamId
 * - Sends: Detection results (bounding boxes + class labels)
 */

import { parseYOLOv8Output, YOLO_INPUT_SIZE } from '../ai/yolo-postprocess';
import type { Detection } from '../ai/detection-overlay';

// ─── Message Types ─────────────────────────────────────────────

interface InferenceInitMessage {
  type: 'init';
  modelUrl: string;
}

interface InferenceFrameMessage {
  type: 'frame';
  streamId: number;
  frame: VideoFrame;
  frameWidth: number;
  frameHeight: number;
}

interface InferenceStopMessage {
  type: 'stop';
}

type InferenceInMessage = InferenceInitMessage | InferenceFrameMessage | InferenceStopMessage;

interface InferenceReadyMessage {
  type: 'ready';
  backend: string;
}

interface InferenceResultMessage {
  type: 'result';
  streamId: number;
  detections: Detection[];
  inferenceTimeMs: number;
}

interface InferenceErrorMessage {
  type: 'error';
  message: string;
}

type InferenceOutMessage = InferenceReadyMessage | InferenceResultMessage | InferenceErrorMessage;

// ─── State ─────────────────────────────────────────────────────

let ort: any = null;
let session: any = null;
let ortReady = false;
let busy = false;

// Reusable OffscreenCanvas for VideoFrame → ImageData conversion
let preprocessCanvas: OffscreenCanvas | null = null;
let preprocessCtx: OffscreenCanvasRenderingContext2D | null = null;

// Reusable Float32 tensor data
let tensorData: Float32Array | null = null;

/** Port for receiving frames from stream worker (transferred from main thread) */
let framePort: MessagePort | null = null;

function postMsg(msg: InferenceOutMessage): void {
  (self as any).postMessage(msg);
}

function postResult(msg: InferenceResultMessage): void {
  // Send results through the frame port so stream worker gets them directly
  if (framePort) {
    framePort.postMessage(msg);
  } else {
    (self as any).postMessage(msg);
  }
}

// ─── Initialization ────────────────────────────────────────────

async function handleInit(modelUrl: string): Promise<void> {
  try {
    // Dynamic import of ONNX Runtime Web.
    // onnxruntime-web is excluded from Vite's optimizeDeps so it loads as native ESM.
    // @ts-ignore
    ort = await import('onnxruntime-web');

    // Point WASM + .mjs glue files at CDN to avoid Vite serving issues.
    // Must be set BEFORE any session creation (initWasm() caches on first call).
    const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';
    ort.env.wasm.wasmPaths = ORT_CDN;
    ort.env.wasm.numThreads = 1;
    // Disable proxy worker — we're already in a worker
    ort.env.wasm.proxy = false;

    let backend = 'wasm';
    try {
      session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
      });
    } catch (e) {
      throw new Error(`Failed to create ORT session: ${e}`);
    }

    // Create preprocessing canvas
    preprocessCanvas = new OffscreenCanvas(YOLO_INPUT_SIZE, YOLO_INPUT_SIZE);
    preprocessCtx = preprocessCanvas.getContext('2d')!;

    // Pre-allocate tensor data
    tensorData = new Float32Array(3 * YOLO_INPUT_SIZE * YOLO_INPUT_SIZE);

    ortReady = true;
    postMsg({ type: 'ready', backend });
    console.log(`[InferenceWorker] Ready (backend: ${backend})`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[InferenceWorker] Init failed:', msg);
    postMsg({ type: 'error', message: `Inference init failed: ${msg}` });
  }
}

// ─── Inference ─────────────────────────────────────────────────

async function handleFrame(
  streamId: number,
  frame: VideoFrame,
  frameWidth: number,
  frameHeight: number,
): Promise<void> {
  if (!ortReady || !session || !preprocessCtx || !tensorData || busy) {
    frame.close();
    return;
  }

  busy = true;
  const startMs = performance.now();

  try {
    // Draw VideoFrame to preprocessing canvas with letterbox
    const scale = Math.min(YOLO_INPUT_SIZE / frameWidth, YOLO_INPUT_SIZE / frameHeight);
    const newW = frameWidth * scale;
    const newH = frameHeight * scale;
    const padX = (YOLO_INPUT_SIZE - newW) / 2;
    const padY = (YOLO_INPUT_SIZE - newH) / 2;

    preprocessCtx.fillStyle = '#808080'; // Gray letterbox fill
    preprocessCtx.fillRect(0, 0, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE);
    preprocessCtx.drawImage(frame, padX, padY, newW, newH);

    // Close the frame ASAP to release GPU memory
    frame.close();

    // Get pixel data
    const imageData = preprocessCtx.getImageData(0, 0, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE);
    const pixels = imageData.data;

    // Convert RGBA to CHW Float32 (normalized 0..1)
    const pixelCount = YOLO_INPUT_SIZE * YOLO_INPUT_SIZE;
    for (let i = 0; i < pixelCount; i++) {
      tensorData[i] = pixels[i * 4] / 255.0;                     // R channel
      tensorData[pixelCount + i] = pixels[i * 4 + 1] / 255.0;    // G channel
      tensorData[2 * pixelCount + i] = pixels[i * 4 + 2] / 255.0; // B channel
    }

    // Run inference
    const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE]);
    const inputName = session.inputNames[0];
    const results = await session.run({ [inputName]: inputTensor });

    // Parse output
    const outputName = session.outputNames[0];
    const output = results[outputName];
    const outputData = output.data as Float32Array;

    // YOLOv8 output shape: [1, 84, 8400]
    const numDetections = output.dims[2];
    const numOutputs = output.dims[1];

    const detections = parseYOLOv8Output(
      { data: outputData, numDetections, numOutputs },
      0.25,
      frameWidth,
      frameHeight,
    );

    const inferenceTimeMs = performance.now() - startMs;

    postResult({
      type: 'result',
      streamId,
      detections,
      inferenceTimeMs,
    });
  } catch (e) {
    try { frame.close(); } catch { /* may already be closed */ }
    console.error('[InferenceWorker] Inference error:', e);
  } finally {
    busy = false;
  }
}

// ─── Message Handler ───────────────────────────────────────────

function handleMessage(msg: any): void {
  switch (msg.type) {
    case 'init':
      handleInit(msg.modelUrl);
      break;
    case 'frame':
      handleFrame(msg.streamId, msg.frame, msg.frameWidth, msg.frameHeight);
      break;
    case 'stop':
      session?.release?.();
      session = null;
      ortReady = false;
      break;
  }
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'setPort') {
    // Main thread transferred a MessagePort connected to stream worker
    framePort = e.ports[0];
    if (framePort) {
      framePort.onmessage = (ev) => handleMessage(ev.data);
    }
    return;
  }
  handleMessage(msg);
};

console.log('[InferenceWorker] Loaded');
