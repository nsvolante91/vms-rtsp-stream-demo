/**
 * WebGPU renderer for video frame grid display.
 *
 * Uses importExternalTexture for zero-copy GPU rendering of VideoFrames.
 * Renders multiple video streams in a configurable grid layout within
 * a single render pass per animation frame.
 *
 * Delegates texture lifecycle management to TextureManager, ensuring
 * that every VideoFrame is closed after rendering even if errors occur.
 */

import { Logger } from '../utils/logger';
import { TextureManager } from './texture-manager';
import shaderCode from './shaders.wgsl?raw';

/** A viewport definition mapping a stream to a normalized canvas region */
interface Viewport {
  /** Stream identifier */
  streamId: number;
  /** Left edge in normalized 0..1 coordinates */
  x: number;
  /** Top edge in normalized 0..1 coordinates */
  y: number;
  /** Width in normalized 0..1 coordinates */
  width: number;
  /** Height in normalized 0..1 coordinates */
  height: number;
}

/** Size of the viewport uniform buffer (12x f32 = 48 bytes) */
const VIEWPORT_UNIFORM_SIZE = 48;

/**
 * WebGPU-based video renderer.
 *
 * Initializes the GPU device, creates a render pipeline with WGSL shaders,
 * and renders decoded VideoFrames into grid cells using importExternalTexture
 * for zero-copy GPU access.
 *
 * CRITICAL: All VideoFrames passed to renderAll() are closed after rendering.
 * The GPUExternalTexture from importExternalTexture is only valid until the
 * current microtask completes, so it must be used in the same synchronous
 * render pass.
 */
export class GPURenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private pipeline!: GPURenderPipeline;
  private sampler!: GPUSampler;
  private textureManager!: TextureManager;
  private viewportBuffers: Map<number, GPUBuffer> = new Map();
  private currentViewports: Viewport[] = [];
  private canvasFormat!: GPUTextureFormat;
  private renderCount = 0;
  private canvas!: HTMLCanvasElement;
  private readonly log: Logger;
  /** Cached bind group layout — avoids getBindGroupLayout(0) per frame */
  private bindGroupLayout!: GPUBindGroupLayout;

  /**
   * Pre-allocated per-stream bind group descriptors.
   * The entries array and descriptor object are created once per stream
   * and mutated in place each frame, avoiding per-frame GC pressure.
   */
  private bindGroupDescriptors: Map<number, GPUBindGroupDescriptor> = new Map();

  /** Cached per-stream video aspect ratios to avoid rewriting buffers every frame */
  private lastVideoARs: Map<number, number> = new Map();
  /** Cached canvas aspect ratio to detect canvas resizes */
  private lastCanvasAR = 0;

  constructor() {
    this.log = new Logger('GPURenderer');
  }

  /**
   * Initialize the WebGPU renderer.
   *
   * Performs the full GPU initialization sequence:
   * 1. Request a high-performance GPU adapter
   * 2. Request a device from the adapter
   * 3. Configure the canvas context for opaque rendering
   * 4. Create the render pipeline with WGSL shaders
   * 5. Create a linear-filtering sampler
   *
   * @param canvas - The HTML canvas element to render into
   * @throws Error if WebGPU is not available or initialization fails
   */
  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported in this browser');
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) {
      throw new Error('Failed to get GPU adapter');
    }

    this.device = await adapter.requestDevice();
    this.device.lost.then((info) => {
      this.log.error(`GPU device lost: ${info.reason}`, info.message);
    });

    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('Failed to get WebGPU canvas context');
    }
    this.context = context;

    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.canvasFormat,
      alphaMode: 'opaque',
    });

    // Create render pipeline
    const shaderModule = this.device.createShaderModule({
      code: shaderCode,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vertexMain',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fragmentMain',
        targets: [{ format: this.canvasFormat }],
      },
      primitive: {
        topology: 'triangle-strip',
        stripIndexFormat: undefined,
      },
    });

    // Create sampler with linear filtering for smooth scaling
    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Cache bind group layout for reuse in pre-allocated descriptors
    this.bindGroupLayout = this.pipeline.getBindGroupLayout(0);

    // Create texture manager for VideoFrame → GPUExternalTexture lifecycle
    this.textureManager = new TextureManager(this.device);

    this.canvas = canvas;
    this.log.info(`Initialized with format ${this.canvasFormat}, canvas ${canvas.width}x${canvas.height}`);
  }

  /**
   * Render all video frames in a single render pass.
   *
   * For each stream that has a frame, creates a GPUExternalTexture via
   * importExternalTexture (zero-copy), builds a bind group, and draws
   * a textured quad at the stream's viewport position.
   *
   * CRITICAL: All VideoFrames in the map are closed after the render pass
   * is submitted. Callers must not use the frames after calling this method.
   *
   * @param frames - Map of streamId to VideoFrame to render
   */
  renderAll(frames: Map<number, VideoFrame>): void {
    this.renderCount++;

    if (this.renderCount <= 3 || this.renderCount % 60 === 0) {
      this.log.info(`renderAll #${this.renderCount}: ${frames.size} frames, ${this.currentViewports.length} viewports, canvas ${this.canvas.width}x${this.canvas.height}`);
    }

    const commandEncoder = this.device.createCommandEncoder();

    const textureView = this.context.getCurrentTexture().createView();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.07, g: 0.07, b: 0.07, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    renderPass.setPipeline(this.pipeline);

    // Import all frames via TextureManager (must happen in same microtask as draw)
    const managedTextures: Array<{ streamId: number; managed: import('./texture-manager').ManagedTexture }> = [];

    for (const viewport of this.currentViewports) {
      const frame = frames.get(viewport.streamId);
      if (!frame) continue;

      try {
        const managed = this.textureManager.importFrame(frame);
        managedTextures.push({ streamId: viewport.streamId, managed });
        // Remove from frames map so we don't double-close
        frames.delete(viewport.streamId);
      } catch (e) {
        this.log.warn(`Failed to import texture for stream ${viewport.streamId}:`, e);
      }
    }

    let rendered = 0;
    const canvasAR = this.canvas.width / this.canvas.height;
    const canvasARChanged = canvasAR !== this.lastCanvasAR;
    if (canvasARChanged) {
      this.lastCanvasAR = canvasAR;
    }

    for (const viewport of this.currentViewports) {
      const entry = managedTextures.find(t => t.streamId === viewport.streamId);
      if (!entry) continue;

      const viewportBuffer = this.viewportBuffers.get(viewport.streamId);
      if (!viewportBuffer) {
        if (this.renderCount <= 5) {
          this.log.warn(`No viewport buffer for stream ${viewport.streamId}`);
        }
        continue;
      }

      // Update viewport buffer for aspect-ratio-correct rendering
      const videoAR = entry.managed.width / entry.managed.height;
      const lastAR = this.lastVideoARs.get(viewport.streamId);
      if (canvasARChanged || videoAR !== lastAR) {
        const cellPixelW = viewport.width * this.canvas.width;
        const cellPixelH = viewport.height * this.canvas.height;
        const cellAR = cellPixelW / cellPixelH;

        let adjScaleX = viewport.width;
        let adjScaleY = viewport.height;

        if (videoAR > cellAR) {
          // Video wider than cell → shrink height
          adjScaleY = viewport.height * (cellAR / videoAR);
        } else {
          // Video taller than cell → shrink width
          adjScaleX = viewport.width * (videoAR / cellAR);
        }

        const offsetX = viewport.x * 2 - 1 + viewport.width;
        const offsetY = 1 - viewport.y * 2 - viewport.height;

        const uniformData = new Float32Array([offsetX, offsetY, adjScaleX, adjScaleY, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 1.0, 1.0]);
        this.device.queue.writeBuffer(viewportBuffer, 0, uniformData);
        this.lastVideoARs.set(viewport.streamId, videoAR);
      }

      try {
        // Mutate pre-allocated descriptor in place — only the external
        // texture entry (binding 1) changes per frame.
        let desc = this.bindGroupDescriptors.get(viewport.streamId);
        if (!desc) {
          desc = {
            layout: this.bindGroupLayout,
            entries: [
              { binding: 0, resource: this.sampler },
              { binding: 1, resource: entry.managed.texture },
              { binding: 2, resource: { buffer: viewportBuffer } },
            ],
          };
          this.bindGroupDescriptors.set(viewport.streamId, desc);
        } else {
          // Mutate only the texture entry (the only thing that changes per frame)
          (desc.entries as GPUBindGroupEntry[])[1] = { binding: 1, resource: entry.managed.texture };
        }

        const bindGroup = this.device.createBindGroup(desc);

        renderPass.setBindGroup(0, bindGroup);
        renderPass.draw(4); // triangle strip quad
        rendered++;
      } catch (e) {
        this.log.warn(`Failed to render stream ${viewport.streamId}:`, e);
      }
    }

    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);

    if (this.renderCount <= 3 || this.renderCount % 60 === 0) {
      this.log.info(`renderAll #${this.renderCount}: rendered ${rendered}/${managedTextures.length} streams`);
    }

    // Release all managed textures (closes the source VideoFrames)
    for (const entry of managedTextures) {
      entry.managed.release();
    }

    // Close any remaining frames that weren't imported (streams not in viewports)
    for (const frame of frames.values()) {
      frame.close();
    }
  }

  /**
   * Update the grid layout viewports.
   *
   * Creates or updates GPU uniform buffers for each viewport, computing
   * the clip-space offset and scale from normalized 0..1 coordinates.
   *
   * Coordinate mapping:
   * - Vertex positions span -1..1, transformed by: p = p * scale + offset
   * - For a cell at normalized (nx, ny) with size (nw, nh):
   *   - scale = vec2(nw, nh)
   *   - offset = vec2(nx*2 - 1 + nw, 1 - ny*2 - nh)
   *
   * @param viewports - Array of viewport definitions with normalized coordinates
   */
  updateLayout(viewports: Viewport[]): void {
    this.currentViewports = viewports;

    // Clean up buffers for streams no longer in the layout
    const activeStreamIds = new Set(viewports.map(v => v.streamId));
    for (const [streamId, buffer] of this.viewportBuffers) {
      if (!activeStreamIds.has(streamId)) {
        buffer.destroy();
        this.viewportBuffers.delete(streamId);
        this.bindGroupDescriptors.delete(streamId);
      }
    }

    // Create or update buffers for each viewport
    for (const viewport of viewports) {
      let buffer = this.viewportBuffers.get(viewport.streamId);
      if (!buffer) {
        buffer = this.device.createBuffer({
          size: VIEWPORT_UNIFORM_SIZE,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.viewportBuffers.set(viewport.streamId, buffer);
      }

      // Convert normalized 0..1 coordinates to clip space
      const offsetX = viewport.x * 2 - 1 + viewport.width;
      const offsetY = 1 - viewport.y * 2 - viewport.height;
      const scaleX = viewport.width;
      const scaleY = viewport.height;

      const uniformData = new Float32Array([offsetX, offsetY, scaleX, scaleY, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 1.0, 1.0]);
      this.device.queue.writeBuffer(buffer, 0, uniformData);

      this.log.info(`Viewport stream ${viewport.streamId}: norm(${viewport.x.toFixed(2)},${viewport.y.toFixed(2)},${viewport.width.toFixed(2)},${viewport.height.toFixed(2)}) → clip offset(${offsetX.toFixed(3)},${offsetY.toFixed(3)}) scale(${scaleX.toFixed(3)},${scaleY.toFixed(3)})`);
    }

    this.log.info(`Layout updated: ${viewports.length} viewports`);
  }

  /**
   * Get information about the GPU being used.
   *
   * Returns a string describing the GPU adapter for benchmark reports.
   * Note: GPU info may be limited by browser privacy settings.
   *
   * @returns Human-readable GPU information string
   */
  getGPUInfo(): string {
    if (!this.device) {
      return 'Not initialized';
    }
    return `WebGPU (${this.canvasFormat})`;
  }

  /**
   * Get texture manager statistics for monitoring.
   *
   * @returns Import/release/error counts and pending frame count
   */
  getTextureStats(): { imported: number; released: number; errors: number; pending: number } {
    if (!this.textureManager) {
      return { imported: 0, released: 0, errors: 0, pending: 0 };
    }
    return {
      imported: this.textureManager.importCount,
      released: this.textureManager.releaseCount,
      errors: this.textureManager.errorCount,
      pending: this.textureManager.pendingCount,
    };
  }

  /**
   * Destroy the renderer and release all GPU resources.
   *
   * Destroys all viewport uniform buffers and the GPU device.
   * After calling destroy(), this renderer instance should not be used again.
   */
  destroy(): void {
    for (const buffer of this.viewportBuffers.values()) {
      buffer.destroy();
    }
    this.viewportBuffers.clear();

    if (this.device) {
      this.device.destroy();
    }

    this.log.info('Renderer destroyed');
  }
}
