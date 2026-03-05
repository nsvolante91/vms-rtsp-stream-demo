/**
 * OffscreenCanvas WebGPU renderer for use inside a Web Worker.
 *
 * Handles WebGPU rendering of VideoFrames onto an OffscreenCanvas
 * using importExternalTexture (zero-copy). This is the worker-side
 * equivalent of StreamTile's drawFrameGPU() — it owns no DOM.
 *
 * CRITICAL: Every VideoFrame passed to drawFrame() is closed after rendering.
 */

import { Logger } from '../utils/logger';
import shaderCode from '../render/shaders.wgsl?raw';

/** Shared GPU state initialized once per worker, reused by all renderers */
export interface WorkerGPU {
  device: GPUDevice;
  format: GPUTextureFormat;
  pipeline: GPURenderPipeline;
  sampler: GPUSampler;
  bindGroupLayout: GPUBindGroupLayout;
  /** Pool of reusable viewport uniform buffers (16 bytes each) */
  viewportBufferPool: GPUBuffer[];
}

/** Maximum number of pre-allocated viewport uniform buffers */
const MAX_POOLED_BUFFERS = 32;

/**
 * Initialize shared WebGPU resources in the worker context.
 *
 * @param onDeviceLost - Optional callback invoked when the GPU device is lost
 * @returns WorkerGPU resources, or null if WebGPU is unavailable
 */
export async function initWorkerGPU(
  onDeviceLost?: (info: GPUDeviceLostInfo) => void
): Promise<WorkerGPU | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return null;
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) {
    return null;
  }

  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();

  const shaderModule = device.createShaderModule({ code: shaderCode });

  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vertexMain',
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fragmentMain',
      targets: [{ format }],
    },
    primitive: {
      topology: 'triangle-strip',
      stripIndexFormat: undefined,
    },
  });

  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
  });

  device.lost.then((info) => {
    console.error(`[WorkerGPU] Device lost: ${info.reason}`, info.message);
    if (onDeviceLost) {
      onDeviceLost(info);
    }
  });

  const bindGroupLayout = pipeline.getBindGroupLayout(0);

  // Pre-allocate viewport uniform buffer pool
  const viewportBufferPool: GPUBuffer[] = [];
  for (let i = 0; i < MAX_POOLED_BUFFERS; i++) {
    const buf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, new Float32Array([0.0, 0.0, 1.0, 1.0]));
    viewportBufferPool.push(buf);
  }

  return { device, format, pipeline, sampler, bindGroupLayout, viewportBufferPool };
}

/**
 * Renders VideoFrames to an OffscreenCanvas via WebGPU.
 *
 * CRITICAL: drawFrame() calls frame.close() after rendering.
 */
export class OffscreenRenderer {
  private readonly canvas: OffscreenCanvas;
  private readonly log: Logger;

  private gpuContext: GPUCanvasContext | null = null;
  private viewportBuffer: GPUBuffer | null = null;
  private gpu: WorkerGPU | null = null;
  /** Pre-allocated bind group descriptor — mutated in place each frame */
  private bindGroupDesc: GPUBindGroupDescriptor | null = null;
  /** Pre-allocated Float32Array for viewport uniform writes */
  private readonly uniformData = new Float32Array(4);

  /** Cached aspect ratios to avoid rewriting the uniform buffer every frame */
  private lastVideoAR = 0;
  private lastCanvasAR = 0;

  constructor(
    readonly streamId: number,
    canvas: OffscreenCanvas
  ) {
    this.canvas = canvas;
    this.log = new Logger(`OffscreenRenderer[${streamId}]`);
  }

  /**
   * Initialize WebGPU rendering on this OffscreenCanvas.
   *
   * @param workerGPU - Shared GPU resources from initWorkerGPU()
   * @returns true if WebGPU was initialized successfully
   */
  initGPU(workerGPU: WorkerGPU): boolean {
    try {
      const gpuContext = this.canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!gpuContext) {
        this.log.warn('Failed to get webgpu context on OffscreenCanvas');
        return false;
      }

      gpuContext.configure({
        device: workerGPU.device,
        format: workerGPU.format,
        alphaMode: 'opaque',
      });

      // Acquire viewport buffer from pool, or create a new one if pool is empty
      const viewportBuffer = workerGPU.viewportBufferPool.pop()
        ?? workerGPU.device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      workerGPU.device.queue.writeBuffer(
        viewportBuffer,
        0,
        new Float32Array([0.0, 0.0, 1.0, 1.0])
      );

      this.gpu = workerGPU;
      this.gpuContext = gpuContext;
      this.viewportBuffer = viewportBuffer;
      return true;
    } catch (e) {
      this.log.warn('WebGPU init failed on OffscreenCanvas', e);
      return false;
    }
  }

  /**
   * Update the canvas backing store dimensions.
   * Called when main thread detects a resize via ResizeObserver.
   */
  resize(width: number, height: number): void {
    if (width > 0 && height > 0) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * Encode a render pass for a decoded VideoFrame and return the command buffer.
   *
   * Does NOT call device.queue.submit() — the caller is responsible for
   * batching all command buffers and submitting them in a single call.
   * CRITICAL: The frame is always closed after encoding.
   *
   * @returns GPUCommandBuffer if encoding succeeded, null otherwise
   */
  encodeFrame(frame: VideoFrame): GPUCommandBuffer | null {
      if (!this.gpu || !this.gpuContext || !this.viewportBuffer) {
        frame.close();
        return null;
      }

      const { device, pipeline, sampler, bindGroupLayout } = this.gpu;

      try {
        // Update viewport uniform for aspect-ratio-correct rendering
        const videoAR = frame.displayWidth / frame.displayHeight;
        const canvasAR = this.canvas.width / this.canvas.height;

        if (videoAR !== this.lastVideoAR || canvasAR !== this.lastCanvasAR) {
          let scaleX = 1.0;
          let scaleY = 1.0;

          if (videoAR > canvasAR) {
            scaleY = canvasAR / videoAR;
          } else {
            scaleX = videoAR / canvasAR;
          }

          this.uniformData[0] = 0.0;
          this.uniformData[1] = 0.0;
          this.uniformData[2] = scaleX;
          this.uniformData[3] = scaleY;
          device.queue.writeBuffer(this.viewportBuffer, 0, this.uniformData);
          this.lastVideoAR = videoAR;
          this.lastCanvasAR = canvasAR;
        }

        // Import the VideoFrame as a GPU external texture (zero-copy)
        const externalTexture = device.importExternalTexture({ source: frame });

        // Reuse pre-allocated bind group descriptor, mutating only the texture entry
        if (!this.bindGroupDesc) {
          this.bindGroupDesc = {
            layout: bindGroupLayout,
            entries: [
              { binding: 0, resource: sampler },
              { binding: 1, resource: externalTexture },
              { binding: 2, resource: { buffer: this.viewportBuffer } },
            ],
          };
        } else {
          (this.bindGroupDesc.entries as GPUBindGroupEntry[])[1] = { binding: 1, resource: externalTexture };
        }

        const bindGroup = device.createBindGroup(this.bindGroupDesc);

        const commandEncoder = device.createCommandEncoder();
        const textureView = this.gpuContext.getCurrentTexture().createView();

        const renderPass = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: textureView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          }],
        });

        renderPass.setPipeline(pipeline);
        renderPass.setBindGroup(0, bindGroup);
        renderPass.draw(4);
        renderPass.end();

        return commandEncoder.finish();
      } catch (e) {
        this.log.warn('WebGPU render failed', e);
        return null;
      } finally {
        // ALWAYS close the frame after encoding to prevent GPU memory leaks
        try { frame.close(); } catch { /* already closed */ }
      }
  }

  /**
   * Draw a decoded VideoFrame and close it (single-stream convenience).
   *
   * Encodes and immediately submits. For multi-stream batching,
   * use encodeFrame() + device.queue.submit() instead.
   */
  drawFrame(frame: VideoFrame): void {
    const cmdBuf = this.encodeFrame(frame);
    if (cmdBuf && this.gpu) {
      this.gpu.device.queue.submit([cmdBuf]);
    }
  }

  /** Release GPU resources, returning pooled buffers */
  destroy(): void {
    if (this.viewportBuffer && this.gpu) {
      // Return buffer to pool for reuse instead of destroying it
      this.gpu.viewportBufferPool.push(this.viewportBuffer);
      this.viewportBuffer = null;
    }
    if (this.gpuContext) {
      this.gpuContext.unconfigure();
      this.gpuContext = null;
    }
    this.bindGroupDesc = null;
    this.gpu = null;
    this.log.info('Destroyed');
  }

  /**
   * Re-initialize GPU resources after a device loss.
   *
   * Reconfigures the canvas context and acquires a new viewport buffer
   * from the pool. Resets aspect ratio cache to force a uniform buffer
   * write on the next frame.
   *
   * @param workerGPU - New shared GPU resources from re-initialization
   * @returns true if recovery succeeded
   */
  reinitGPU(workerGPU: WorkerGPU): boolean {
    // Clean up stale state without returning buffer to old pool
    this.gpuContext = null;
    this.viewportBuffer = null;
    this.bindGroupDesc = null;
    this.gpu = null;
    this.lastVideoAR = 0;
    this.lastCanvasAR = 0;
    return this.initGPU(workerGPU);
  }
}
