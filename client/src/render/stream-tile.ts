/**
 * Per-stream video tile with its own canvas element.
 *
 * Each tile creates a wrapper div containing a <canvas> for video rendering
 * and a label overlay showing stream info. ResizeObserver keeps the canvas
 * backing store matched to its CSS size.
 *
 * Supports two rendering modes:
 * - **WebGPU** (default): Uses `importExternalTexture` for zero-copy GPU rendering
 * - **Canvas2D** (fallback): Uses `drawImage(VideoFrame)` when WebGPU is unavailable
 *
 * The rendering mode is set once via `initGPU()` or falls back to Canvas2D.
 */

import { Logger } from '../utils/logger';
import type { ZoomCrop } from '../worker/messages';
import shaderCode from './shaders.wgsl?raw';

/** Shared GPU state passed from the app to each tile */
export interface SharedGPU {
  /** The GPUDevice shared across all tiles */
  device: GPUDevice;
  /** Preferred canvas texture format */
  format: GPUTextureFormat;
  /** Pre-compiled shader module (shared across tiles) */
  shaderModule: GPUShaderModule;
  /** Pre-created render pipeline (shared across tiles) */
  pipeline: GPURenderPipeline;
  /** Linear-filtering sampler (shared across tiles) */
  sampler: GPUSampler;
  /** Cached bind group layout from the pipeline */
  bindGroupLayout: GPUBindGroupLayout;
}

/**
 * Initialize shared WebGPU resources used by all StreamTiles.
 *
 * Requests a high-performance GPU adapter and device, creates the
 * shared shader module, render pipeline, and sampler. These are
 * shared across all tiles to avoid duplicating GPU objects.
 *
 * @returns SharedGPU resources, or null if WebGPU is unavailable
 */
export async function initSharedGPU(): Promise<SharedGPU | null> {
  if (!navigator.gpu) {
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
    console.error(`[SharedGPU] Device lost: ${info.reason}`, info.message);
  });

  const bindGroupLayout = pipeline.getBindGroupLayout(0);

  return { device, format, shaderModule, pipeline, sampler, bindGroupLayout };
}

/**
 * A single video stream tile with its own canvas and label overlay.
 *
 * CRITICAL: The drawFrame() method calls frame.close() after rendering.
 * Callers must not use the frame after passing it to drawFrame().
 */
export class StreamTile {
  /** The outer wrapper div to append to the grid container */
  readonly element: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly label: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly log: Logger;

  // Canvas2D fallback
  private ctx2d: CanvasRenderingContext2D | null = null;

  // WebGPU state (per-tile context, shared device/pipeline)
  private gpu: SharedGPU | null = null;
  private gpuContext: GPUCanvasContext | null = null;
  /** Full-screen viewport uniform buffer for this tile */
  private viewportBuffer: GPUBuffer | null = null;
  private useWebGPU = false;

  /** Cached video aspect ratio to avoid rewriting the uniform buffer every frame */
  private lastVideoAR = 0;
  /** Cached canvas aspect ratio to detect canvas resizes */
  private lastCanvasAR = 0;

  /** True after transferControlToOffscreen() — canvas dimensions are worker-owned */
  private _transferred = false;
  /** Callback invoked on resize when canvas is transferred (pixel dimensions) */
  private _resizeCallback: ((width: number, height: number) => void) | null = null;

  // ── Zoom state ────────────────────────────────────────────────
  private _zoomCallback: ((streamId: number, crop: ZoomCrop | null) => void) | null = null;
  private _zoomCrop: ZoomCrop | null = null;
  private _isDragging = false;
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _dragMoved = false;
  private readonly selectionOverlay: HTMLDivElement;
  private readonly resetZoomBtn: HTMLDivElement;
  private readonly zoomLevelLabel: HTMLSpanElement;

  // ── Pause state ───────────────────────────────────────────────
  private _pauseCallback: ((streamId: number, paused: boolean) => void) | null = null;
  private _paused = false;
  private readonly pauseBtn: HTMLDivElement;
  private readonly pausedOverlay: HTMLDivElement;
  private _escHandler: ((e: KeyboardEvent) => void) | null = null;

  // ── Double-tap detection (touch) ───────────────────────────
  private _lastTapTime = 0;
  private _lastTapX = 0;
  private _lastTapY = 0;

  // ── Pinch-to-zoom (touch) ─────────────────────────────────
  private readonly _activePointers = new Map<number, { x: number; y: number }>();
  private _isPinching = false;
  private _initialPinchDist = 0;
  private _initialPinchMidX = 0;
  private _initialPinchMidY = 0;
  private _pinchStartCrop: ZoomCrop | null = null;

  // ── One-finger pan (touch, when zoomed) ────────────────────
  private _isPanning = false;
  private _panLastX = 0;
  private _panLastY = 0;

  // ── DPR cap for mobile ─────────────────────────────────────
  private _maxDPR = 0; // 0 = no cap

  // ── Comparison mode ───────────────────────────────────────────
  private _comparisonLabel: string | null = null;

  // ── Worker renderer type ────────────────────────────────────
  private _workerRenderer: 'webgpu' | 'canvas2d' | null = null;
  private _rendererBadge: HTMLDivElement | null = null;

  constructor(readonly streamId: number) {
    this.log = new Logger(`Tile[${streamId}]`);

    // Wrapper div
    this.element = document.createElement('div');
    this.element.className = 'stream-tile';
    this.element.dataset.streamId = String(streamId);

    // Canvas fills the tile
    this.canvas = document.createElement('canvas');
    this.element.appendChild(this.canvas);

    // Label overlay
    this.label = document.createElement('div');
    this.label.className = 'stream-label';
    this.label.textContent = `Stream ${streamId}`;
    this.element.appendChild(this.label);

    // ── Pause button (top-right corner) ──────────────────────
    this.pauseBtn = document.createElement('div');
    this.pauseBtn.className = 'tile-pause-btn';
    this.pauseBtn.textContent = '⏸';
    this.pauseBtn.title = 'Pause/Resume stream';
    this.pauseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._paused = !this._paused;
      this.pauseBtn.textContent = this._paused ? '▶' : '⏸';
      this.pausedOverlay.classList.toggle('visible', this._paused);
      this._pauseCallback?.(this.streamId, this._paused);
    });
    this.element.appendChild(this.pauseBtn);

    // Paused overlay (centered ⏸ icon + dimming)
    this.pausedOverlay = document.createElement('div');
    this.pausedOverlay.className = 'tile-paused-overlay';
    this.pausedOverlay.innerHTML = '<span>⏸</span>';
    this.element.appendChild(this.pausedOverlay);

    // ── Zoom selection overlay (visible during drag) ─────────
    this.selectionOverlay = document.createElement('div');
    this.selectionOverlay.className = 'tile-selection-overlay';
    this.element.appendChild(this.selectionOverlay);

    // ── Reset zoom button (visible when zoomed) ──────────────
    this.resetZoomBtn = document.createElement('div');
    this.resetZoomBtn.className = 'tile-reset-zoom';
    this.zoomLevelLabel = document.createElement('span');
    this.zoomLevelLabel.className = 'tile-zoom-level';
    this.resetZoomBtn.appendChild(this.zoomLevelLabel);
    const resetX = document.createElement('span');
    resetX.textContent = ' ✕ Reset';
    resetX.className = 'tile-reset-zoom-action';
    this.resetZoomBtn.appendChild(resetX);
    this.resetZoomBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.resetZoom();
    });
    this.element.appendChild(this.resetZoomBtn);

    // ── Zoom drag handlers (Pointer Events — unifies mouse + touch + stylus) ──
    this.element.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    this.element.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    this.element.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    this.element.addEventListener('pointercancel', (e) => {
      this._activePointers.delete(e.pointerId);
      this.cancelDrag();
    });
    // Only cancel on pointerleave for mouse — touch uses pointer capture
    this.element.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch') this.cancelDrag();
    });
    this.element.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (this._zoomCrop) {
        this.resetZoom();
      }
    });

    // Escape key resets zoom
    this._escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this._zoomCrop) {
        this.resetZoom();
      }
    };
    document.addEventListener('keydown', this._escHandler);

    // Keep canvas backing store matched to CSS display size
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        let dpr = window.devicePixelRatio || 1;
        if (this._maxDPR > 0 && dpr > this._maxDPR) {
          dpr = this._maxDPR;
        }
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        if (w > 0 && h > 0) {
          const pw = Math.round(w * dpr);
          const ph = Math.round(h * dpr);
          if (this._transferred) {
            // Canvas is owned by worker — notify via callback
            this._resizeCallback?.(pw, ph);
          } else {
            this.canvas.width = pw;
            this.canvas.height = ph;
          }
        }
      }
    });
    this.resizeObserver.observe(this.canvas);
  }

  /**
   * Initialize WebGPU rendering for this tile.
   *
   * Configures the canvas with a WebGPU context using the shared device.
   * Creates a full-screen viewport uniform buffer (offset=0,0 scale=1,1)
   * for per-tile rendering where each tile fills its own canvas.
   *
   * @param sharedGPU - Shared GPU resources from initSharedGPU()
   * @returns true if WebGPU was initialized, false on failure (falls back to Canvas2D)
   */
  initGPU(sharedGPU: SharedGPU): boolean {
    try {
      const gpuContext = this.canvas.getContext('webgpu');
      if (!gpuContext) {
        this.log.warn('Failed to get webgpu context, falling back to Canvas2D');
        return this.initCanvas2D();
      }

      gpuContext.configure({
        device: sharedGPU.device,
        format: sharedGPU.format,
        alphaMode: 'opaque',
      });

      // Full-screen viewport: offset (0,0), scale (1,1) in clip space
      const viewportBuffer = sharedGPU.device.createBuffer({
        size: 48, // 12x f32: offset, scale, texelSize, mode, sharpness, uvOffset, uvScale
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      // Clip-space mapping: offset(0,0) scale(1,1) means the quad fills -1..1
      // UV zoom identity: uvOffset(0,0) uvScale(1,1) = no zoom
      sharedGPU.device.queue.writeBuffer(
        viewportBuffer,
        0,
        new Float32Array([0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 1.0, 1.0])
      );

      this.gpu = sharedGPU;
      this.gpuContext = gpuContext;
      this.viewportBuffer = viewportBuffer;
      this.useWebGPU = true;
      return true;
    } catch (e) {
      this.log.warn('WebGPU init failed, falling back to Canvas2D', e);
      return this.initCanvas2D();
    }
  }

  /**
   * Initialize Canvas2D fallback rendering.
   *
   * @returns false to indicate Canvas2D fallback was used
   */
  private initCanvas2D(): boolean {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx2d = ctx;
    this.useWebGPU = false;
    return false;
  }

  /**
   * Draw a decoded VideoFrame to this tile's canvas and close it.
   *
   * Uses WebGPU importExternalTexture for zero-copy GPU rendering
   * when available, otherwise falls back to Canvas2D drawImage.
   *
   * CRITICAL: The frame is closed after drawing. Do not use the frame
   * after calling this method.
   */
  drawFrame(frame: VideoFrame): void {
    if (this.useWebGPU && this.gpu && this.gpuContext && this.viewportBuffer) {
      this.drawFrameGPU(frame);
    } else {
      this.drawFrameCanvas2D(frame);
    }
  }

  /**
   * Render a VideoFrame via WebGPU importExternalTexture (zero-copy).
   *
   * The GPUExternalTexture is only valid until the current microtask
   * completes, so import → bind → draw → submit all happen synchronously.
   *
   * Updates the viewport uniform buffer when the video or canvas aspect
   * ratio changes to maintain square pixel aspect ratio (letterbox/pillarbox).
   */
  private drawFrameGPU(frame: VideoFrame): void {
    const { device, pipeline, sampler, bindGroupLayout } = this.gpu!;

    try {
      // Update viewport uniform for aspect-ratio-correct rendering
      const videoAR = frame.displayWidth / frame.displayHeight;
      const canvasAR = this.canvas.width / this.canvas.height;

      if (videoAR !== this.lastVideoAR || canvasAR !== this.lastCanvasAR) {
        let scaleX = 1.0;
        let scaleY = 1.0;

        if (videoAR > canvasAR) {
          // Video is wider than canvas → pillarbox (black bars top/bottom)
          scaleY = canvasAR / videoAR;
        } else {
          // Video is taller than canvas → letterbox (black bars left/right)
          scaleX = videoAR / canvasAR;
        }

        device.queue.writeBuffer(
          this.viewportBuffer!,
          0,
          new Float32Array([0.0, 0.0, scaleX, scaleY, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 1.0, 1.0])
        );
        this.lastVideoAR = videoAR;
        this.lastCanvasAR = canvasAR;
      }

      // Import the VideoFrame as a GPU external texture (zero-copy)
      const externalTexture = device.importExternalTexture({
        source: frame,
      });

      const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: externalTexture },
          { binding: 2, resource: { buffer: this.viewportBuffer! } },
        ],
      });

      const commandEncoder = device.createCommandEncoder();
      const textureView = this.gpuContext!.getCurrentTexture().createView();

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

  /**
   * Render a VideoFrame via Canvas2D drawImage (fallback).
   *
   * Maintains square pixel aspect ratio by letterboxing/pillarboxing
   * the video within the canvas.
   */
  private drawFrameCanvas2D(frame: VideoFrame): void {
    if (!this.ctx2d) {
      // Lazy init for tiles that didn't call initGPU
      const ctx = this.canvas.getContext('2d');
      if (!ctx) {
        frame.close();
        return;
      }
      this.ctx2d = ctx;
    }

    try {
      const cw = this.canvas.width;
      const ch = this.canvas.height;

      // Compute letterbox/pillarbox to preserve video aspect ratio
      const videoAR = frame.displayWidth / frame.displayHeight;
      const canvasAR = cw / ch;

      let dw: number, dh: number, dx: number, dy: number;
      if (videoAR > canvasAR) {
        // Video is wider → fit to width, black bars top/bottom
        dw = cw;
        dh = cw / videoAR;
        dx = 0;
        dy = (ch - dh) / 2;
      } else {
        // Video is taller → fit to height, black bars left/right
        dh = ch;
        dw = ch * videoAR;
        dx = (cw - dw) / 2;
        dy = 0;
      }

      // Clear background for letterbox/pillarbox bars
      this.ctx2d.fillStyle = '#000';
      this.ctx2d.fillRect(0, 0, cw, ch);
      this.ctx2d.drawImage(frame, dx, dy, dw, dh);
    } catch (e) {
      this.log.warn('Canvas2D render failed', e);
    } finally {
      frame.close();
    }
  }

  /**
   * Transfer the canvas to an OffscreenCanvas for worker-side rendering.
   *
   * After this call, the main thread can no longer write to canvas dimensions
   * or get contexts. The ResizeObserver will fire the resize callback instead.
   *
   * @returns The OffscreenCanvas and its current pixel dimensions
   */
  transferCanvas(): { canvas: OffscreenCanvas; width: number; height: number } {
    if (this._transferred) {
      throw new Error(`Tile ${this.streamId}: canvas already transferred`);
    }
    let dpr = window.devicePixelRatio || 1;
    if (this._maxDPR > 0 && dpr > this._maxDPR) {
      dpr = this._maxDPR;
    }
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.round(rect.width * dpr) || 640;
    const height = Math.round(rect.height * dpr) || 360;

    // Set initial size before transfer
    this.canvas.width = width;
    this.canvas.height = height;

    const offscreen = this.canvas.transferControlToOffscreen();
    this._transferred = true;
    this.log.info(`Canvas transferred (${width}x${height})`);
    return { canvas: offscreen, width, height };
  }

  /**
   * Register a callback for resize events when the canvas is worker-owned.
   * The callback receives pixel dimensions (CSS size × devicePixelRatio).
   */
  onResize(callback: (width: number, height: number) => void): void {
    this._resizeCallback = callback;
  }

  /** Register a callback for zoom crop changes. */
  onZoom(callback: (streamId: number, crop: ZoomCrop | null) => void): void {
    this._zoomCallback = callback;
  }

  /** Register a callback for pause state changes. */
  onPause(callback: (streamId: number, paused: boolean) => void): void {
    this._pauseCallback = callback;
  }

  /** Whether a drag (not a simple click) occurred during the last mouse interaction. */
  get wasDrag(): boolean {
    return this._dragMoved;
  }

  /** Set maximum DPR cap for ResizeObserver (0 = no cap). */
  setMaxDPR(maxDPR: number): void {
    this._maxDPR = maxDPR;
  }

  // ── Zoom interaction (Pointer Events) ───────────────────────
  //
  // Mouse: drag-to-select rectangle → zoom into that area
  // Touch: pinch-to-zoom + one-finger pan when zoomed + double-tap reset/2x

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.tile-pause-btn') || target.closest('.tile-reset-zoom') || target.closest('.stream-label')) return;

    this.element.setPointerCapture(e.pointerId);

    if (e.pointerType === 'touch') {
      // ── Touch path: track active pointers for pinch/pan ──
      const rect = this.element.getBoundingClientRect();
      this._activePointers.set(e.pointerId, {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });

      if (this._activePointers.size === 2) {
        // Two fingers down → start pinch
        this._isPinching = true;
        this._isPanning = false;
        this._dragMoved = true; // suppress click handler
        this.element.style.touchAction = 'none';

        const pts = Array.from(this._activePointers.values());
        this._initialPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        this._initialPinchMidX = (pts[0].x + pts[1].x) / 2;
        this._initialPinchMidY = (pts[0].y + pts[1].y) / 2;
        this._pinchStartCrop = this._zoomCrop
          ? { ...this._zoomCrop }
          : { x: 0, y: 0, w: 1, h: 1 };
      } else if (this._activePointers.size === 1) {
        // One finger down — start pan if already zoomed, otherwise just track for tap
        this._dragMoved = false;
        if (this._zoomCrop) {
          this._isPanning = true;
          this.element.style.touchAction = 'none';
          this._panLastX = e.clientX - rect.left;
          this._panLastY = e.clientY - rect.top;
        }
      }
    } else {
      // ── Mouse path: rectangle selection (unchanged) ──
      this.element.style.touchAction = 'none';
      this._isDragging = true;
      this._dragMoved = false;
      const rect = this.element.getBoundingClientRect();
      this._dragStartX = e.clientX - rect.left;
      this._dragStartY = e.clientY - rect.top;
      this.selectionOverlay.style.display = 'none';
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      const rect = this.element.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      this._activePointers.set(e.pointerId, { x: px, y: py });

      if (this._isPinching && this._activePointers.size >= 2 && this._pinchStartCrop) {
        // ── Pinch-to-zoom ──
        const pts = Array.from(this._activePointers.values());
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;

        if (this._initialPinchDist < 1) return;
        const scale = dist / this._initialPinchDist;

        const sc = this._pinchStartCrop;
        // New crop size — clamped to [0.05, 1]
        const newW = Math.min(1, Math.max(0.05, sc.w / scale));
        const newH = Math.min(1, Math.max(0.05, sc.h / scale));

        // Zoom centered on initial midpoint (in UV space)
        const midU = sc.x + (this._initialPinchMidX / rect.width) * sc.w;
        const midV = sc.y + (this._initialPinchMidY / rect.height) * sc.h;

        // Also pan based on midpoint movement
        const panDU = ((this._initialPinchMidX - midX) / rect.width) * newW;
        const panDV = ((this._initialPinchMidY - midY) / rect.height) * newH;

        let newX = midU - newW / 2 + panDU;
        let newY = midV - newH / 2 + panDV;

        // Clamp to [0, 1-size]
        newX = Math.max(0, Math.min(1 - newW, newX));
        newY = Math.max(0, Math.min(1 - newH, newY));

        // If zoomed out to full view, reset
        if (newW >= 0.99 && newH >= 0.99) {
          this._zoomCrop = null;
        } else {
          this._zoomCrop = { x: newX, y: newY, w: newW, h: newH };
        }
        this.updateZoomUI();
        this._zoomCallback?.(this.streamId, this._zoomCrop);

      } else if (this._isPanning && this._zoomCrop && this._activePointers.size === 1) {
        // ── One-finger pan ──
        const dx = px - this._panLastX;
        const dy = py - this._panLastY;

        // Convert pixel movement to UV delta (invert: drag right → shift crop left)
        const du = (-dx / rect.width) * this._zoomCrop.w;
        const dv = (-dy / rect.height) * this._zoomCrop.h;

        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          this._dragMoved = true;
        }

        let newX = this._zoomCrop.x + du;
        let newY = this._zoomCrop.y + dv;
        newX = Math.max(0, Math.min(1 - this._zoomCrop.w, newX));
        newY = Math.max(0, Math.min(1 - this._zoomCrop.h, newY));

        this._zoomCrop = { ...this._zoomCrop, x: newX, y: newY };
        this._zoomCallback?.(this.streamId, this._zoomCrop);

        this._panLastX = px;
        this._panLastY = py;
      }

      return;
    }

    // ── Mouse rectangle selection ──
    if (!this._isDragging) return;

    const rect = this.element.getBoundingClientRect();
    const currentX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const currentY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));

    const dx = Math.abs(currentX - this._dragStartX);
    const dy = Math.abs(currentY - this._dragStartY);

    if (dx < 5 && dy < 5) return;
    this._dragMoved = true;

    const left = Math.min(this._dragStartX, currentX);
    const top = Math.min(this._dragStartY, currentY);
    const width = Math.abs(currentX - this._dragStartX);
    const height = Math.abs(currentY - this._dragStartY);

    this.selectionOverlay.style.display = 'block';
    this.selectionOverlay.style.left = `${left}px`;
    this.selectionOverlay.style.top = `${top}px`;
    this.selectionOverlay.style.width = `${width}px`;
    this.selectionOverlay.style.height = `${height}px`;
  }

  private handlePointerUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this._activePointers.delete(e.pointerId);

      // If we were pinching and a finger lifts, stop pinching
      if (this._isPinching) {
        if (this._activePointers.size < 2) {
          this._isPinching = false;
          this._pinchStartCrop = null;
          // If one finger remains, transition to pan
          if (this._activePointers.size === 1 && this._zoomCrop) {
            this._isPanning = true;
            const remaining = Array.from(this._activePointers.values())[0];
            this._panLastX = remaining.x;
            this._panLastY = remaining.y;
          }
        }
        return;
      }

      // End of pan
      if (this._isPanning) {
        this._isPanning = false;
        this.element.style.touchAction = 'manipulation';
      }

      // Double-tap detection (reset zoom or zoom 2x)
      if (!this._dragMoved) {
        const now = performance.now();
        const dt = now - this._lastTapTime;
        const tapDx = Math.abs(e.clientX - this._lastTapX);
        const tapDy = Math.abs(e.clientY - this._lastTapY);

        if (dt < 300 && tapDx < 30 && tapDy < 30) {
          if (this._zoomCrop) {
            // Double-tap when zoomed → reset
            this.resetZoom();
          } else {
            // Double-tap when not zoomed → zoom 2x centered on tap
            const rect = this.element.getBoundingClientRect();
            const tapU = (e.clientX - rect.left) / rect.width;
            const tapV = (e.clientY - rect.top) / rect.height;
            const w = 0.5, h = 0.5;
            const x = Math.max(0, Math.min(1 - w, tapU - w / 2));
            const y = Math.max(0, Math.min(1 - h, tapV - h / 2));
            this._zoomCrop = { x, y, w, h };
            this.updateZoomUI();
            this._zoomCallback?.(this.streamId, this._zoomCrop);
          }
          this._lastTapTime = 0;
          return;
        }

        this._lastTapTime = now;
        this._lastTapX = e.clientX;
        this._lastTapY = e.clientY;
      }

      if (this._activePointers.size === 0) {
        this.element.style.touchAction = 'manipulation';
      }
      return;
    }

    // ── Mouse rectangle selection end ──
    if (!this._isDragging) return;
    this._isDragging = false;
    this.selectionOverlay.style.display = 'none';
    this.element.style.touchAction = 'manipulation';

    if (!this._dragMoved) return;

    const rect = this.element.getBoundingClientRect();
    const currentX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const currentY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));

    const left = Math.min(this._dragStartX, currentX);
    const top = Math.min(this._dragStartY, currentY);
    const width = Math.abs(currentX - this._dragStartX);
    const height = Math.abs(currentY - this._dragStartY);

    if (width < 10 || height < 10) return;

    const crop: ZoomCrop = {
      x: left / rect.width,
      y: top / rect.height,
      w: width / rect.width,
      h: height / rect.height,
    };

    this._zoomCrop = crop;
    this.updateZoomUI();
    this._zoomCallback?.(this.streamId, crop);
  }

  private cancelDrag(): void {
    if (this._isDragging) {
      this._isDragging = false;
      this.selectionOverlay.style.display = 'none';
      this.element.style.touchAction = 'manipulation';
    }
    if (this._isPinching || this._isPanning) {
      this._isPinching = false;
      this._isPanning = false;
      this._pinchStartCrop = null;
      this._activePointers.clear();
      this.element.style.touchAction = 'manipulation';
    }
  }

  private resetZoom(): void {
    this._zoomCrop = null;
    this.updateZoomUI();
    this._zoomCallback?.(this.streamId, null);
  }

  private updateZoomUI(): void {
    if (this._zoomCrop) {
      const zoomX = 1 / this._zoomCrop.w;
      const zoomY = 1 / this._zoomCrop.h;
      const effectiveZoom = Math.min(zoomX, zoomY);
      this.zoomLevelLabel.textContent = `${effectiveZoom.toFixed(1)}×`;
      this.resetZoomBtn.classList.add('visible');
    } else {
      this.resetZoomBtn.classList.remove('visible');
    }
  }

  /** Update the label overlay text. */
  updateLabel(resolution: string, fps: number): void {
    let renderer: string;
    if (this._transferred && this._workerRenderer) {
      renderer = this._workerRenderer === 'webgpu' ? 'WebGPU Worker' : 'Canvas2D Worker';
    } else if (this._transferred) {
      renderer = 'Worker';
    } else {
      renderer = this.useWebGPU ? 'WebGPU' : 'Canvas2D';
    }
    const prefix = this._comparisonLabel ? `${this._comparisonLabel} | ` : '';
    this.label.textContent = `${prefix}Stream ${this.streamId > 10000 ? this.streamId - 10000 : this.streamId} | ${resolution} | ${fps} fps | ${renderer}`;
  }

  /**
   * Set the actual renderer type reported by the worker.
   * Shows a red warning badge when Canvas2D fallback is active,
   * including the reason WebGPU failed.
   */
  setWorkerRenderer(renderer: 'webgpu' | 'canvas2d', gpuFailReason?: string): void {
    this._workerRenderer = renderer;

    if (renderer === 'canvas2d' && !this._rendererBadge) {
      const badge = document.createElement('div');
      const reason = gpuFailReason ?? 'unknown';
      badge.innerHTML = reason.includes('requestAdapter')
        ? 'Canvas2D fallback — GPU blocklisted.<br>Try chrome://flags/#enable-unsafe-webgpu'
        : `Canvas2D fallback — WebGPU failed: ${reason}`;
      badge.style.cssText =
        'position:absolute;top:4px;right:4px;background:rgba(220,38,38,0.85);' +
        'color:#fff;font-size:11px;padding:2px 8px;border-radius:4px;' +
        'pointer-events:none;z-index:10;font-family:monospace;';
      this.element.appendChild(badge);
      this._rendererBadge = badge;
    }
  }

  /** Set a comparison mode label prefix (e.g. 'Original' or 'Upscaled'). Null clears it. */
  setComparisonLabel(label: string | null): void {
    this._comparisonLabel = label;
  }

  /** Set zoom crop externally (for syncing between companion and primary tiles). */
  setZoomExternal(crop: ZoomCrop | null): void {
    this._zoomCrop = crop;
    this.updateZoomUI();
  }

  /** Remove from DOM and clean up. */
  destroy(): void {
    this.resizeObserver.disconnect();

    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }

    if (this.viewportBuffer) {
      this.viewportBuffer.destroy();
      this.viewportBuffer = null;
    }

    // Unconfigure the WebGPU context
    if (this.gpuContext) {
      this.gpuContext.unconfigure();
      this.gpuContext = null;
    }

    this.gpu = null;
    this._rendererBadge?.remove();
    this._rendererBadge = null;
    this.element.remove();
    this.log.info('Destroyed');
  }
}
