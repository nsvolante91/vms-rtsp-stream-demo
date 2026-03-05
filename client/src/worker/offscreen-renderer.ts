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
}

/**
 * Initialize shared WebGPU resources in the worker context.
 *
 * @returns WorkerGPU resources, or null if WebGPU is unavailable
 */
export async function initWorkerGPU(): Promise<WorkerGPU | null> {
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
  });

  return { device, format, pipeline, sampler };
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

      const viewportBuffer = workerGPU.device.createBuffer({
        size: 16, // 2x vec2<f32>
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
   * Draw a decoded VideoFrame and close it.
   *
   * Uses importExternalTexture for zero-copy GPU rendering.
   * CRITICAL: The frame is always closed after drawing.
   */
  drawFrame(frame: VideoFrame): void {
    if (!this.gpu || !this.gpuContext || !this.viewportBuffer) {
      frame.close();
      return;
    }

    const { device, pipeline, sampler } = this.gpu;

    try {
      // Update viewport uniform for aspect-ratio-correct rendering
      const videoAR = frame.displayWidth / frame.displayHeight;
      const canvasAR = this.canvas.width / this.canvas.height;

      if (videoAR !== this.lastVideoAR || canvasAR !== this.lastCanvasAR) {
        let scaleX = 1.0;
        let scaleY = 1.0;

        if (videoAR > canvasAR) {
          // Video is wider than canvas → black bars top/bottom
          scaleY = canvasAR / videoAR;
        } else {
          // Video is taller than canvas → black bars left/right
          scaleX = videoAR / canvasAR;
        }

        device.queue.writeBuffer(
          this.viewportBuffer,
          0,
          new Float32Array([0.0, 0.0, scaleX, scaleY])
        );
        this.lastVideoAR = videoAR;
        this.lastCanvasAR = canvasAR;
      }

      // Import the VideoFrame as a GPU external texture (zero-copy)
      const externalTexture = device.importExternalTexture({ source: frame });

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: externalTexture },
          { binding: 2, resource: { buffer: this.viewportBuffer } },
        ],
      });

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

      device.queue.submit([commandEncoder.finish()]);
    } catch (e) {
      this.log.warn('WebGPU render failed', e);
    } finally {
      // ALWAYS close the frame to prevent GPU memory leaks
      frame.close();
    }
  }

  /** Release GPU resources */
  destroy(): void {
    if (this.viewportBuffer) {
      this.viewportBuffer.destroy();
      this.viewportBuffer = null;
    }
    if (this.gpuContext) {
      this.gpuContext.unconfigure();
      this.gpuContext = null;
    }
    this.gpu = null;
    this.log.info('Destroyed');
  }
}
