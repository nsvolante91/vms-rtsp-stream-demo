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
import type { UpscaleMode, ZoomCrop } from './messages';
import shaderCode from '../render/shaders.wgsl?raw';
import blitShaderCode from '../render/blit-shader.wgsl?raw';
import temporalShaderCode from '../render/temporal-shaders.wgsl?raw';
import spectralShaderCode from '../render/spectral-shaders.wgsl?raw';
import vqsrShaderCode from '../render/vqsr-shaders.wgsl?raw';
import genShaderCode from '../render/gen-shaders.wgsl?raw';
import dlssShaderCode from '../render/dlss-shaders.wgsl?raw';
import { CNNVL, CNNM } from 'anime4k-webgpu';
import type { Anime4KPipeline } from 'anime4k-webgpu';

/** Shared blit render pipeline for rendering rgba16float → rgba8unorm canvas */
export interface BlitPipeline {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
}

/** Lazy-initialized compute pipelines for TSR mode */
export interface TSRPipelines {
  motionEstimate: GPUComputePipeline;
  accumulate: GPUComputePipeline;
  sharpen: GPUComputePipeline;
  shaderModule: GPUShaderModule;
}

/** Lazy-initialized compute pipelines for SPEC mode */
export interface SPECPipelines {
  dctForward: GPUComputePipeline;
  hallucinate: GPUComputePipeline;
  dctInverse: GPUComputePipeline;
  shaderModule: GPUShaderModule;
}

/** Lazy-initialized compute pipelines for VQSR mode */
export interface VQSRPipelines {
  encode: GPUComputePipeline;
  lookup: GPUComputePipeline;
  blend: GPUComputePipeline;
  shaderModule: GPUShaderModule;
}

/** Lazy-initialized compute pipelines for GEN mode */
export interface GENPipelines {
  featureExtract: GPUComputePipeline;
  rrdb: GPUComputePipeline;
  reconstruct: GPUComputePipeline;
  blend: GPUComputePipeline;
  shaderModule: GPUShaderModule;
}

/** Lazy-initialized compute pipelines for DLSS mode */
export interface DLSSPipelines {
  motionDepth: GPUComputePipeline;
  temporalAccum: GPUComputePipeline;
  spatialEnhance: GPUComputePipeline;
  finalReconstruct: GPUComputePipeline;
  shaderModule: GPUShaderModule;
}

/** Shared GPU state initialized once per worker, reused by all renderers */
export interface WorkerGPU {
  device: GPUDevice;
  format: GPUTextureFormat;
  pipeline: GPURenderPipeline;
  /** Render pipeline that outputs to rgba8unorm (for copy-to-texture) */
  copyPipeline: GPURenderPipeline;
  sampler: GPUSampler;
  bindGroupLayout: GPUBindGroupLayout;
  copyBindGroupLayout: GPUBindGroupLayout;
  /** Pool of reusable viewport uniform buffers (32 bytes each) */
  viewportBufferPool: GPUBuffer[];
  /** Lazy blit pipeline — created on first use for A4K modes */
  blitPipeline?: BlitPipeline;
  /** Lazy TSR compute pipelines — created on first use */
  tsr?: TSRPipelines;
  /** Lazy SPEC compute pipelines — created on first use */
  spec?: SPECPipelines;
  /** Lazy VQSR compute pipelines — created on first use */
  vqsr?: VQSRPipelines;
  /** Lazy GEN compute pipelines — created on first use */
  gen?: GENPipelines;
  /** Lazy DLSS compute pipelines — created on first use */
  dlss?: DLSSPipelines;
}

/** Maximum number of pre-allocated viewport uniform buffers */
const MAX_POOLED_BUFFERS = 32;

/** Uniform buffer size in bytes: 12 floats × 4 = 48 */
const UNIFORM_BUFFER_SIZE = 48;

/**
 * Initialize shared WebGPU resources in the worker context.
 *
 * @param onDeviceLost - Optional callback invoked when the GPU device is lost
 * @returns WorkerGPU resources, or null if WebGPU is unavailable
 */
/** Reason why WebGPU initialization failed */
export type GPUFailReason =
  | 'navigator.gpu missing'
  | 'requestAdapter returned null'
  | 'getContext webgpu failed'
  | string;

/** Result of initWorkerGPU — either success or a failure reason */
export type InitGPUResult =
  | { ok: true; gpu: WorkerGPU }
  | { ok: false; reason: GPUFailReason };

export async function initWorkerGPU(
  onDeviceLost?: (info: GPUDeviceLostInfo) => void,
  gpuPowerPreference?: GPUPowerPreference
): Promise<InitGPUResult> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return { ok: false, reason: 'navigator.gpu missing' };
  }

  // Try with preferred power hint first, then without any options as fallback
  let adapter = await navigator.gpu.requestAdapter({
    powerPreference: gpuPowerPreference ?? 'high-performance',
  });
  if (!adapter && gpuPowerPreference) {
    adapter = await navigator.gpu.requestAdapter();
  }
  if (!adapter) {
    return { ok: false, reason: `requestAdapter returned null (tried '${gpuPowerPreference ?? 'high-performance'}' and default)` };
  }

  const device = await adapter.requestDevice();
  // Use rgba8unorm (not getPreferredCanvasFormat which returns bgra8unorm on macOS)
  // because compute shaders need STORAGE_BINDING and rgba8unorm always supports it
  const format: GPUTextureFormat = 'rgba8unorm';

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

  // Pipeline that renders to rgba8unorm texture (for A4K/TSR copy step)
  const copyPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vertexMain',
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fragmentMain',
      targets: [{ format: 'rgba8unorm' }],
    },
    primitive: {
      topology: 'triangle-strip',
      stripIndexFormat: undefined,
    },
  });
  const copyBindGroupLayout = copyPipeline.getBindGroupLayout(0);

  // Pre-allocate viewport uniform buffer pool
  // 48 bytes: [offsetX, offsetY, scaleX, scaleY, texelSizeX, texelSizeY, mode, sharpness, uvOffsetX, uvOffsetY, uvScaleX, uvScaleY]
  const viewportBufferPool: GPUBuffer[] = [];
  for (let i = 0; i < MAX_POOLED_BUFFERS; i++) {
    const buf = device.createBuffer({
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, new Float32Array([0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 1.0, 1.0]));
    viewportBufferPool.push(buf);
  }

  return { ok: true, gpu: { device, format, pipeline, copyPipeline, sampler, bindGroupLayout, copyBindGroupLayout, viewportBufferPool } };
}

/**
 * Lazily initialize the blit render pipeline. Called once on first A4K usage,
 * then stored on WorkerGPU for reuse across all renderers.
 */
export function ensureBlitPipeline(gpu: WorkerGPU): BlitPipeline {
  if (gpu.blitPipeline) return gpu.blitPipeline;

  const shaderModule = gpu.device.createShaderModule({ code: blitShaderCode });

  const pipeline = gpu.device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vertexMain',
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fragmentMain',
      targets: [{ format: 'rgba8unorm' }],
    },
    primitive: {
      topology: 'triangle-strip',
      stripIndexFormat: undefined,
    },
  });

  const bindGroupLayout = pipeline.getBindGroupLayout(0);

  gpu.blitPipeline = { pipeline, bindGroupLayout };
  return gpu.blitPipeline;
}

/**
 * Lazily initialize TSR compute pipelines. Called once on first TSR usage,
 * then stored on WorkerGPU for reuse across all renderers.
 */
export function ensureTSRPipelines(gpu: WorkerGPU): TSRPipelines {
  if (gpu.tsr) return gpu.tsr;

  const shaderModule = gpu.device.createShaderModule({ code: temporalShaderCode });

  const motionEstimate = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'tsr_motion_estimate' },
  });

  const accumulate = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'tsr_accumulate' },
  });

  const sharpen = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'tsr_sharpen' },
  });

  gpu.tsr = { motionEstimate, accumulate, sharpen, shaderModule };
  return gpu.tsr;
}

/**
 * Lazily initialize SPEC compute pipelines. Called once on first SPEC usage.
 */
export function ensureSPECPipelines(gpu: WorkerGPU): SPECPipelines {
  if (gpu.spec) return gpu.spec;

  const shaderModule = gpu.device.createShaderModule({ code: spectralShaderCode });

  const dctForward = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'spec_dct_forward' },
  });

  const hallucinate = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'spec_hallucinate' },
  });

  const dctInverse = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'spec_dct_inverse' },
  });

  gpu.spec = { dctForward, hallucinate, dctInverse, shaderModule };
  return gpu.spec;
}

/**
 * Lazily initialize VQSR compute pipelines. Called once on first VQSR usage.
 */
export function ensureVQSRPipelines(gpu: WorkerGPU): VQSRPipelines {
  if (gpu.vqsr) return gpu.vqsr;

  const shaderModule = gpu.device.createShaderModule({ code: vqsrShaderCode });

  const encode = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'vqsr_encode' },
  });

  const lookup = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'vqsr_lookup' },
  });

  const blend = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'vqsr_blend' },
  });

  gpu.vqsr = { encode, lookup, blend, shaderModule };
  return gpu.vqsr;
}

/**
 * Lazily initialize GEN compute pipelines. Called once on first GEN usage.
 */
export function ensureGENPipelines(gpu: WorkerGPU): GENPipelines {
  if (gpu.gen) return gpu.gen;

  const shaderModule = gpu.device.createShaderModule({ code: genShaderCode });

  const featureExtract = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'gen_feature_extract' },
  });

  const rrdb = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'gen_rrdb' },
  });

  const reconstruct = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'gen_reconstruct' },
  });

  const blend = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'gen_blend' },
  });

  gpu.gen = { featureExtract, rrdb, reconstruct, blend, shaderModule };
  return gpu.gen;
}

/**
 * Lazily initialize DLSS compute pipelines. Called once on first DLSS usage.
 */
export function ensureDLSSPipelines(gpu: WorkerGPU): DLSSPipelines {
  if (gpu.dlss) return gpu.dlss;

  const shaderModule = gpu.device.createShaderModule({ code: dlssShaderCode });

  const motionDepth = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'dlss_motion_depth' },
  });

  const temporalAccum = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'dlss_temporal_accum_main' },
  });

  const spatialEnhance = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'dlss_spatial_enhance' },
  });

  const finalReconstruct = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'dlss_final_reconstruct' },
  });

  gpu.dlss = { motionDepth, temporalAccum, spatialEnhance, finalReconstruct, shaderModule };
  return gpu.dlss;
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
  /** Pre-allocated Float32Array for viewport uniform writes (48 bytes) */
  private readonly uniformData = new Float32Array(12);

  /** Current zoom crop (null = full view) */
  private zoomCrop: ZoomCrop | null = null;

  /** Cached aspect ratios to avoid rewriting the uniform buffer every frame */
  private lastVideoAR = 0;
  private lastCanvasAR = 0;

  /** Current upscale mode: 0=off, 1=cas, 2=fsr, 3=a4k, 4=tsr, 9=a4k-fast */
  private upscaleModeValue = 0;
  /** Whether uniforms need a full rewrite (e.g. after mode change) */
  private uniformsDirty = true;

  // ── Anime4K pipeline state (per-renderer) ──────────────────
  private a4kPipeline: Anime4KPipeline | null = null;
  private a4kInputW = 0;
  private a4kInputH = 0;
  private a4kCurrentMode: 'a4k' | 'a4k-fast' | null = null;

  // ── A4K/TSR intermediate textures (created lazily) ──────────
  private sourceCopyTex: GPUTexture | null = null;
  private intermediateA: GPUTexture | null = null;
  private intermediateB: GPUTexture | null = null;
  private lastIntermediateW = 0;
  private lastIntermediateH = 0;
  /** "Identity" viewport buffer for copy pass (mode=0, full scale) */
  private copyViewportBuffer: GPUBuffer | null = null;

  // ── TSR temporal state ──────────────────────────────────────
  private prevFrameTex: GPUTexture | null = null;
  private accumTex: GPUTexture | null = null;
  private motionVecTex: GPUTexture | null = null;
  private tsrFrameCount = 0;
  private tsrUniformBuffer: GPUBuffer | null = null;
  private readonly tsrUniformData = new Float32Array(8);

  // ── SPEC/VQSR/GEN float32 intermediate textures ────────────
  private dctCoeffTex: GPUTexture | null = null;
  private dctFilledTex: GPUTexture | null = null;
  private featureTex: GPUTexture | null = null;
  private detailTex: GPUTexture | null = null;
  // GEN: 2 sets of 4× rgba32float textures for 16ch features (ping-pong)
  private genFeatA: GPUTexture[] = [];
  private genFeatB: GPUTexture[] = [];
  private genResidualTex: GPUTexture | null = null;
  private lastFloat32W = 0;
  private lastFloat32H = 0;
  /** Uniform buffer for SPEC/VQSR/GEN compute passes */
  private specVqsrGenUniformBuffer: GPUBuffer | null = null;
  private readonly specVqsrGenUniformData = new Float32Array(8);
  /** Per-RRDB uniform buffers (4 buffers, one per RRDB dispatch) */
  private genRRDBUniformBuffers: GPUBuffer[] = [];

  // ── Cached compute bind groups (invalidated on texture resize) ──
  /** TSR bind groups that reference only stable textures/buffers */
  private tsrCachedBGs: {
    meBG0: GPUBindGroup; meBG1: GPUBindGroup;
    accumBG0: GPUBindGroup; accumBG1: GPUBindGroup;
    sharpenBG0: GPUBindGroup;
  } | null = null;
  /** SPEC bind groups that reference only stable textures/buffers */
  private specCachedBGs: {
    dctFwdBG0: GPUBindGroup; dctFwdBG1: GPUBindGroup;
    hallBG0: GPUBindGroup; hallBG1: GPUBindGroup;
    idctBG0: GPUBindGroup;
  } | null = null;
  /** VQSR bind groups that reference only stable textures/buffers */
  private vqsrCachedBGs: {
    encBG0: GPUBindGroup; encBG1: GPUBindGroup;
    lookBG0: GPUBindGroup; lookBG1: GPUBindGroup;
    blndBG0: GPUBindGroup;
  } | null = null;
  /** GEN bind groups that reference only stable textures/buffers */
  private genCachedBGs: {
    feBG0: GPUBindGroup; feBG1: GPUBindGroup;
    rrdbBGs: { bg0: GPUBindGroup; bg1: GPUBindGroup }[];
    reconBG0: GPUBindGroup; reconBG1: GPUBindGroup;
    blendBG0: GPUBindGroup;
  } | null = null;
  /** DLSS bind groups that reference only stable textures/buffers */
  private dlssCachedBGs: {
    motionBG0: GPUBindGroup; motionBG1: GPUBindGroup;
    accumBG0: GPUBindGroup; accumBG1: GPUBindGroup;
    spatialBG0: GPUBindGroup; spatialBG1: GPUBindGroup;
    finalBG0: GPUBindGroup;
  } | null = null;
  /** A4K blit bind group (stable output texture) */
  private a4kCachedBlitBG: GPUBindGroup | null = null;

  // ── DLSS temporal + spatial state ──────────────────────────
  private dlssPrevFrameTex: GPUTexture | null = null;
  private dlssAccumTex: GPUTexture | null = null;
  private dlssAccumOutTex: GPUTexture | null = null;
  private dlssMotionVecTex: GPUTexture | null = null;
  private dlssDepthHintsTex: GPUTexture | null = null;
  private dlssEnhancedTex: GPUTexture | null = null;
  private dlssUniformBuffer: GPUBuffer | null = null;
  private readonly dlssUniformData = new Float32Array(8);
  private dlssFrameCount = 0;
  private lastDlssW = 0;
  private lastDlssH = 0;

  /** Canvas2D fallback context (used when WebGPU is unavailable) */
  private ctx2d: OffscreenCanvasRenderingContext2D | null = null;

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
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
      });

      // Acquire viewport buffer from pool, or create a new one if pool is empty
      const viewportBuffer = workerGPU.viewportBufferPool.pop()
        ?? workerGPU.device.createBuffer({
          size: UNIFORM_BUFFER_SIZE,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      workerGPU.device.queue.writeBuffer(
        viewportBuffer,
        0,
        new Float32Array([0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 1.0, 1.0])
      );
      this.uniformsDirty = true;

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
   * Initialize Canvas2D fallback rendering on this OffscreenCanvas.
   * Used when WebGPU is unavailable (e.g. on some mobile devices).
   *
   * @returns true if Canvas2D was initialized successfully
   */
  initCanvas2D(): boolean {
    try {
      const ctx = this.canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) {
        this.log.warn('Failed to get 2d context on OffscreenCanvas');
        return false;
      }
      this.ctx2d = ctx;
      this.log.info('Canvas2D fallback initialized');
      return true;
    } catch (e) {
      this.log.warn('Canvas2D init failed on OffscreenCanvas', e);
      return false;
    }
  }

  /** Whether this renderer is using Canvas2D fallback */
  get isCanvas2D(): boolean {
    return this.ctx2d !== null;
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

  /** Set zoom crop region (null = reset to full view) */
  setZoom(crop: ZoomCrop | null): void {
    this.zoomCrop = crop;
    this.uniformsDirty = true;
  }

  /** Write zoom-aware viewport data to the copy buffer used by compute paths */
  private writeCopyViewport(device: GPUDevice, videoW: number, videoH: number): void {
    if (!this.copyViewportBuffer) return;

    // Compute aspect-ratio-correct scaling (same logic as modes 0-2)
    const videoAR = videoW / videoH;
    const canvasAR = this.canvas.width / this.canvas.height;
    let scaleX = 1.0;
    let scaleY = 1.0;
    if (videoAR > canvasAR) {
      scaleY = canvasAR / videoAR;
    } else {
      scaleX = videoAR / canvasAR;
    }

    const crop = this.zoomCrop;
    device.queue.writeBuffer(this.copyViewportBuffer, 0, new Float32Array([
      0.0, 0.0, scaleX, scaleY, 1.0 / videoW, 1.0 / videoH, 0.0, 0.5,
      crop ? crop.x : 0.0, crop ? crop.y : 0.0, crop ? crop.w : 1.0, crop ? crop.h : 1.0
    ]));
  }

  /** Set GPU upscale mode for this renderer */
  setUpscaleMode(mode: UpscaleMode): void {
    const modeMap: Record<UpscaleMode, number> = { off: 0, cas: 1, fsr: 2, a4k: 3, tsr: 4, spec: 5, vqsr: 6, gen: 7, dlss: 8, 'a4k-fast': 9 };
    const prev = this.upscaleModeValue;
    this.upscaleModeValue = modeMap[mode];
    this.uniformsDirty = true;

    // Reset TSR accumulation when leaving TSR mode
    if (prev === 4 && this.upscaleModeValue !== 4) {
      this.tsrFrameCount = 0;
    }
    // Reset TSR accumulation when entering TSR mode
    if (prev !== 4 && this.upscaleModeValue === 4) {
      this.tsrFrameCount = 0;
    }

    // Reset DLSS accumulation when entering/leaving DLSS mode
    if (prev === 8 && this.upscaleModeValue !== 8) {
      this.dlssFrameCount = 0;
    }
    if (prev !== 8 && this.upscaleModeValue === 8) {
      this.dlssFrameCount = 0;
    }

    // Lazy-init compute/blit pipelines
    if (this.gpu) {
      if (this.upscaleModeValue === 3 || this.upscaleModeValue === 9) ensureBlitPipeline(this.gpu);
      if (this.upscaleModeValue === 4) ensureTSRPipelines(this.gpu);
      if (this.upscaleModeValue === 5) ensureSPECPipelines(this.gpu);
      if (this.upscaleModeValue === 6) ensureVQSRPipelines(this.gpu);
      if (this.upscaleModeValue === 7) ensureGENPipelines(this.gpu);
      if (this.upscaleModeValue === 8) ensureDLSSPipelines(this.gpu);
    }
  }

  /**
   * Encode a render pass for a decoded VideoFrame and return the command buffer.
   *
   * Does NOT call device.queue.submit() or frame.close() — the caller is
   * responsible for batching command buffers, submitting them, and then
   * closing all frames AFTER submit. This is required because
   * GPUExternalTexture references the VideoFrame's underlying data and
   * becomes invalid if the frame is closed before submit.
   *
   * For modes 0-2 (off/cas/fsr): single render pass with fragment shader.
   * For mode 3 (a4k): render-to-copy + 3 compute dispatches in one cmd buffer.
   * For mode 4 (tsr): render-to-copy + 3 compute dispatches + texture copies.
   *
   * @returns GPUCommandBuffer if encoding succeeded, null otherwise
   */
  encodeFrame(frame: VideoFrame): GPUCommandBuffer | null {
      // Canvas2D fallback path — draw immediately, no command buffer needed
      if (this.ctx2d) {
        const ctx = this.ctx2d;
        const cw = this.canvas.width;
        const ch = this.canvas.height;
        ctx.clearRect(0, 0, cw, ch);

        // Aspect-ratio-correct letterboxing
        const videoAR = frame.displayWidth / frame.displayHeight;
        const canvasAR = cw / ch;
        let dw: number, dh: number, dx: number, dy: number;
        if (videoAR > canvasAR) {
          dw = cw;
          dh = cw / videoAR;
          dx = 0;
          dy = (ch - dh) / 2;
        } else {
          dh = ch;
          dw = ch * videoAR;
          dx = (cw - dw) / 2;
          dy = 0;
        }

        // Apply zoom crop if set
        if (this.zoomCrop) {
          const sx = frame.displayWidth * this.zoomCrop.x;
          const sy = frame.displayHeight * this.zoomCrop.y;
          const sw = frame.displayWidth * this.zoomCrop.w;
          const sh = frame.displayHeight * this.zoomCrop.h;
          ctx.drawImage(frame, sx, sy, sw, sh, dx, dy, dw, dh);
        } else {
          ctx.drawImage(frame, dx, dy, dw, dh);
        }

        return null;
      }

      if (!this.gpu || !this.gpuContext || !this.viewportBuffer) {
        return null;
      }

      const { device, pipeline, sampler, bindGroupLayout } = this.gpu;

      try {
        // Update viewport uniform for aspect-ratio-correct rendering
        const videoW = frame.displayWidth;
        const videoH = frame.displayHeight;
        const videoAR = videoW / videoH;
        const canvasAR = this.canvas.width / this.canvas.height;

        if (videoAR !== this.lastVideoAR || canvasAR !== this.lastCanvasAR || this.uniformsDirty) {
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
          this.uniformData[4] = 1.0 / videoW;
          this.uniformData[5] = 1.0 / videoH;
          // For modes 3/4, the render pass uses mode 0 (bilinear) to copy the frame
          this.uniformData[6] = this.upscaleModeValue <= 2 ? this.upscaleModeValue : 0;
          this.uniformData[7] = this.upscaleModeValue === 2 ? 0.8 : 0.5;
          // Zoom UV crop
          if (this.zoomCrop) {
            this.uniformData[8] = this.zoomCrop.x;
            this.uniformData[9] = this.zoomCrop.y;
            this.uniformData[10] = this.zoomCrop.w;
            this.uniformData[11] = this.zoomCrop.h;
          } else {
            this.uniformData[8] = 0.0;
            this.uniformData[9] = 0.0;
            this.uniformData[10] = 1.0;
            this.uniformData[11] = 1.0;
          }
          device.queue.writeBuffer(this.viewportBuffer, 0, this.uniformData);
          this.lastVideoAR = videoAR;
          this.lastCanvasAR = canvasAR;
          this.uniformsDirty = false;
        }

        // Import the VideoFrame as a GPU external texture (zero-copy)
        const externalTexture = device.importExternalTexture({ source: frame });

        // ── A4K compute path (mode 3 = a4k, mode 9 = a4k-fast) ──
        if (this.upscaleModeValue === 3 || this.upscaleModeValue === 9) {
          return this.encodeA4K(device, externalTexture, sampler, videoW, videoH);
        }

        // ── TSR compute path ──────────────────────────────────
        if (this.upscaleModeValue === 4) {
          return this.encodeTSR(device, externalTexture, sampler, videoW, videoH);
        }

        // ── SPEC compute path ─────────────────────────────────
        if (this.upscaleModeValue === 5) {
          return this.encodeSPEC(device, externalTexture, sampler, videoW, videoH);
        }

        // ── VQSR compute path ─────────────────────────────────
        if (this.upscaleModeValue === 6) {
          return this.encodeVQSR(device, externalTexture, sampler, videoW, videoH);
        }

        // ── GEN compute path ──────────────────────────────────
        if (this.upscaleModeValue === 7) {
          return this.encodeGEN(device, externalTexture, sampler, videoW, videoH);
        }

        // ── DLSS compute path ─────────────────────────────────
        if (this.upscaleModeValue === 8) {
          return this.encodeDLSS(device, externalTexture, sampler, videoW, videoH);
        }

        // ── Standard render path (off/cas/fsr) ───────────────
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
      }
  }

  // ── Intermediate texture management ─────────────────────────

  /** Ensure intermediate textures exist at the right size */
  private ensureIntermediateTextures(device: GPUDevice, w: number, h: number): void {
    if (this.lastIntermediateW === w && this.lastIntermediateH === h && this.sourceCopyTex) {
      return;
    }

    // Destroy old textures
    this.sourceCopyTex?.destroy();
    this.intermediateA?.destroy();
    this.intermediateB?.destroy();

    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING |
                  GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST |
                  GPUTextureUsage.COPY_SRC;

    this.sourceCopyTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage,
    });

    this.intermediateA = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    this.intermediateB = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    this.lastIntermediateW = w;
    this.lastIntermediateH = h;

    // Invalidate all compute bind group caches (they reference sourceCopyTex/intermediateA)
    this.tsrCachedBGs = null;
    this.specCachedBGs = null;
    this.vqsrCachedBGs = null;
    this.genCachedBGs = null;
    this.dlssCachedBGs = null;
    this.a4kCachedBlitBG = null;

    // Create identity-scale viewport buffer for copy pass
    if (!this.copyViewportBuffer) {
      this.copyViewportBuffer = device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
  }

  /** Ensure TSR temporal textures exist at the right size */
  private ensureTSRTextures(device: GPUDevice, w: number, h: number): void {
    // Recreate if dimensions changed
    const needsRecreate = !this.prevFrameTex ||
      this.prevFrameTex.width !== w || this.prevFrameTex.height !== h;

    if (!needsRecreate) return;

    this.prevFrameTex?.destroy();
    this.accumTex?.destroy();
    this.motionVecTex?.destroy();

    const rgbaUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING |
                      GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;

    this.prevFrameTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: rgbaUsage,
    });

    this.accumTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: rgbaUsage,
    });

    this.motionVecTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rg32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    if (!this.tsrUniformBuffer) {
      this.tsrUniformBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    this.tsrFrameCount = 0;
    this.tsrCachedBGs = null;
  }

  /**
   * Destroy internal GPU textures created by the anime4k-webgpu library pipeline.
   * The library has no dispose/destroy API, so we manually iterate its sub-pipelines
   * and destroy their output textures to prevent GPU memory leaks.
   */
  private destroyA4KPipelineTextures(): void {
    if (!this.a4kPipeline) return;
    const pipeline = this.a4kPipeline as CNNVL | CNNM;
    if (pipeline.pipelines) {
      const destroyed = new Set<GPUTexture>();
      for (const sub of pipeline.pipelines) {
        const tex = sub.getOutputTexture();
        if (!destroyed.has(tex)) {
          tex.destroy();
          destroyed.add(tex);
        }
      }
    }
    this.a4kPipeline = null;
  }

  // ── A4K (anime4k-webgpu) Encode ────────────────────────────

  /**
   * Ensure the per-renderer Anime4K pipeline exists and matches current dimensions/mode.
   * Recreates when canvas dimensions change or mode switches between a4k/a4k-fast.
   */
  private ensureA4KPipeline(device: GPUDevice): void {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const wantedMode: 'a4k' | 'a4k-fast' = this.upscaleModeValue === 9 ? 'a4k-fast' : 'a4k';

    if (this.a4kPipeline && this.a4kInputW === cw && this.a4kInputH === ch && this.a4kCurrentMode === wantedMode) {
      return;
    }

    // Destroy old pipeline's internal GPU textures (library has no dispose API)
    this.destroyA4KPipelineTextures();

    // (Re)create: library bind groups reference sourceCopyTex internally
    this.a4kPipeline = wantedMode === 'a4k'
      ? new CNNVL({ device, inputTexture: this.sourceCopyTex! })
      : new CNNM({ device, inputTexture: this.sourceCopyTex! });
    this.a4kInputW = cw;
    this.a4kInputH = ch;
    this.a4kCurrentMode = wantedMode;
    this.a4kCachedBlitBG = null;
  }

  /**
   * Encode A4K passes: external texture → sourceCopy → anime4k-webgpu compute → blit → canvas.
   * Works for both a4k (CNNVL, 17 sub-passes) and a4k-fast (CNNM, 8 sub-passes).
   */
  private encodeA4K(
    device: GPUDevice,
    externalTexture: GPUExternalTexture,
    sampler: GPUSampler,
    videoW: number,
    videoH: number,
  ): GPUCommandBuffer | null {
    if (!this.gpu?.blitPipeline || !this.gpuContext) return null;
    const { copyPipeline, copyBindGroupLayout, blitPipeline } = this.gpu;

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ensureIntermediateTextures(device, cw, ch);
    if (!this.sourceCopyTex || !this.copyViewportBuffer) return null;

    // Ensure anime4k-webgpu pipeline is created/up-to-date
    this.ensureA4KPipeline(device);
    if (!this.a4kPipeline) return null;

    const commandEncoder = device.createCommandEncoder();

    // Step 1: Render external texture → sourceCopyTex (bilinear, with zoom crop)
    this.writeCopyViewport(device, videoW, videoH);

    const copyBindGroup = device.createBindGroup({
      layout: copyBindGroupLayout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: externalTexture },
        { binding: 2, resource: { buffer: this.copyViewportBuffer } },
      ],
    });

    const copyPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.sourceCopyTex.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    copyPass.setPipeline(copyPipeline);
    copyPass.setBindGroup(0, copyBindGroup);
    copyPass.draw(4);
    copyPass.end();

    // Step 2: anime4k-webgpu compute sub-passes
    this.a4kPipeline.pass(commandEncoder);

    // Step 3: Blit library output (rgba16float) → canvas (rgba8unorm)
    // Cache the blit bind group — output texture is stable until pipeline recreation
    if (!this.a4kCachedBlitBG) {
      const outputTex = this.a4kPipeline.getOutputTexture();
      this.a4kCachedBlitBG = device.createBindGroup({
        layout: blitPipeline.bindGroupLayout,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: outputTex.createView() },
        ],
      });
    }
    const blitBindGroup = this.a4kCachedBlitBG;

    const canvasTex = this.gpuContext.getCurrentTexture();
    const blitPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: canvasTex.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    blitPass.setPipeline(blitPipeline.pipeline);
    blitPass.setBindGroup(0, blitBindGroup);
    blitPass.draw(4);
    blitPass.end();

    return commandEncoder.finish();
  }

  // ── TSR Compute Encode ──────────────────────────────────────

  /**
   * Encode TSR compute passes: external texture → sourceCopy → motion estimate →
   * temporal accumulate → sharpen → canvas. Plus copy sourceCopy → prevFrame.
   */
  private encodeTSR(
    device: GPUDevice,
    externalTexture: GPUExternalTexture,
    sampler: GPUSampler,
    videoW: number,
    videoH: number,
  ): GPUCommandBuffer | null {
    if (!this.gpu?.tsr || !this.gpuContext) return null;
    const { tsr, copyPipeline, copyBindGroupLayout } = this.gpu;

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ensureIntermediateTextures(device, cw, ch);
    this.ensureTSRTextures(device, cw, ch);
    if (!this.sourceCopyTex || !this.prevFrameTex || !this.accumTex || !this.motionVecTex || !this.tsrUniformBuffer || !this.copyViewportBuffer) return null;

    const commandEncoder = device.createCommandEncoder();

    // Step 1: Render external texture → sourceCopyTex (bilinear, mode=0)
    this.writeCopyViewport(device, videoW, videoH);

    const copyBindGroup = device.createBindGroup({
      layout: copyBindGroupLayout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: externalTexture },
        { binding: 2, resource: { buffer: this.copyViewportBuffer } },
      ],
    });

    const copyPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.sourceCopyTex.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    copyPass.setPipeline(copyPipeline);
    copyPass.setBindGroup(0, copyBindGroup);
    copyPass.draw(4);
    copyPass.end();

    // Update TSR uniforms
    this.tsrUniformData[0] = 1.0 / cw;
    this.tsrUniformData[1] = 1.0 / ch;
    this.tsrUniformData[2] = cw;
    this.tsrUniformData[3] = ch;
    this.tsrUniformData[4] = this.tsrFrameCount;
    this.tsrUniformData[5] = 0.7;  // sharpness
    this.tsrUniformData[6] = 0.3;  // sceneCutThreshold
    this.tsrUniformData[7] = 0.85; // accumWeight
    device.queue.writeBuffer(this.tsrUniformBuffer, 0, this.tsrUniformData);

    const wgX = Math.ceil(cw / 8);
    const wgY = Math.ceil(ch / 8);

    // Cache stable bind groups (recreated only on texture resize)
    if (!this.tsrCachedBGs) {
      this.ensureIntermediateTextures(device, cw, ch);
      if (!this.intermediateA) return null;
      this.tsrCachedBGs = {
        meBG0: device.createBindGroup({
          layout: tsr.motionEstimate.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.tsrUniformBuffer } },
          ],
        }),
        meBG1: device.createBindGroup({
          layout: tsr.motionEstimate.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: this.prevFrameTex.createView() },
            { binding: 1, resource: this.motionVecTex.createView() },
          ],
        }),
        accumBG0: device.createBindGroup({
          layout: tsr.accumulate.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.tsrUniformBuffer } },
          ],
        }),
        accumBG1: device.createBindGroup({
          layout: tsr.accumulate.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: this.motionVecTex.createView() },
            { binding: 1, resource: this.accumTex.createView() },
            { binding: 2, resource: this.intermediateA.createView() },
          ],
        }),
        sharpenBG0: device.createBindGroup({
          layout: tsr.sharpen.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.tsrUniformBuffer } },
          ],
        }),
      };
    }
    const { meBG0, meBG1, accumBG0, accumBG1, sharpenBG0 } = this.tsrCachedBGs;

    // Step 2: Motion estimation
    const mePass = commandEncoder.beginComputePass();
    mePass.setPipeline(tsr.motionEstimate);
    mePass.setBindGroup(0, meBG0);
    mePass.setBindGroup(1, meBG1);
    mePass.dispatchWorkgroups(wgX, wgY);
    mePass.end();

    // Step 3: Temporal accumulation
    this.ensureIntermediateTextures(device, cw, ch);
    if (!this.intermediateA) return null;

    const accumPass = commandEncoder.beginComputePass();
    accumPass.setPipeline(tsr.accumulate);
    accumPass.setBindGroup(0, accumBG0);
    accumPass.setBindGroup(1, accumBG1);
    accumPass.dispatchWorkgroups(wgX, wgY);
    accumPass.end();

    // Copy intermediateA → accumTex (update accumulation buffer for next frame)
    commandEncoder.copyTextureToTexture(
      { texture: this.intermediateA },
      { texture: this.accumTex },
      { width: cw, height: ch },
    );

    // Step 4: RCAS sharpen → canvas (sharpenBG1 references canvasTex — must be per-frame)
    const canvasTex = this.gpuContext.getCurrentTexture();
    const sharpenBG1 = device.createBindGroup({
      layout: tsr.sharpen.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: this.intermediateA.createView() },
        { binding: 1, resource: canvasTex.createView() },
      ],
    });

    const sharpenPass = commandEncoder.beginComputePass();
    sharpenPass.setPipeline(tsr.sharpen);
    sharpenPass.setBindGroup(0, sharpenBG0);
    sharpenPass.setBindGroup(1, sharpenBG1);
    sharpenPass.dispatchWorkgroups(wgX, wgY);
    sharpenPass.end();

    // Step 5: Copy sourceCopyTex → prevFrameTex for next frame's motion estimation
    commandEncoder.copyTextureToTexture(
      { texture: this.sourceCopyTex },
      { texture: this.prevFrameTex },
      { width: cw, height: ch },
    );

    this.tsrFrameCount++;

    return commandEncoder.finish();
  }

  // ── Float32 texture management (SPEC/VQSR/GEN) ─────────────

  /** Ensure float32 intermediate textures exist at the right size */
  private ensureFloat32Textures(device: GPUDevice, w: number, h: number): void {
    if (this.lastFloat32W === w && this.lastFloat32H === h && this.dctCoeffTex) {
      return;
    }

    // Destroy old textures
    this.dctCoeffTex?.destroy();
    this.dctFilledTex?.destroy();
    this.featureTex?.destroy();
    this.detailTex?.destroy();
    this.genResidualTex?.destroy();
    for (const t of this.genFeatA) t.destroy();
    for (const t of this.genFeatB) t.destroy();

    const floatUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;

    // SPEC: 2 × rgba32float
    this.dctCoeffTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba32float',
      usage: floatUsage,
    });
    this.dctFilledTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba32float',
      usage: floatUsage,
    });

    // VQSR: featureTex (rgba32float) + detailTex (rgba8unorm)
    this.featureTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba32float',
      usage: floatUsage,
    });
    this.detailTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    // GEN: 2 sets × 4 rgba32float textures (ping-pong, 16ch total per set)
    this.genFeatA = [];
    this.genFeatB = [];
    for (let i = 0; i < 4; i++) {
      this.genFeatA.push(device.createTexture({
        size: { width: w, height: h },
        format: 'rgba32float',
        usage: floatUsage,
      }));
      this.genFeatB.push(device.createTexture({
        size: { width: w, height: h },
        format: 'rgba32float',
        usage: floatUsage,
      }));
    }

    // GEN: residual texture (rgba8unorm)
    this.genResidualTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    this.lastFloat32W = w;
    this.lastFloat32H = h;
    this.specCachedBGs = null;
    this.vqsrCachedBGs = null;
    this.genCachedBGs = null;

    if (!this.specVqsrGenUniformBuffer) {
      this.specVqsrGenUniformBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    // Create per-RRDB uniform buffers if not already created
    if (this.genRRDBUniformBuffers.length === 0) {
      for (let i = 0; i < 4; i++) {
        this.genRRDBUniformBuffers.push(device.createBuffer({
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }));
      }
    }
  }

  // ── SPEC Compute Encode ─────────────────────────────────────

  private encodeSPEC(
    device: GPUDevice,
    externalTexture: GPUExternalTexture,
    sampler: GPUSampler,
    videoW: number,
    videoH: number,
  ): GPUCommandBuffer | null {
    if (!this.gpu?.spec || !this.gpuContext) return null;
    const { spec, copyPipeline, copyBindGroupLayout } = this.gpu;

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ensureIntermediateTextures(device, cw, ch);
    this.ensureFloat32Textures(device, cw, ch);
    if (!this.sourceCopyTex || !this.dctCoeffTex || !this.dctFilledTex ||
        !this.specVqsrGenUniformBuffer || !this.copyViewportBuffer) return null;

    const commandEncoder = device.createCommandEncoder();

    // Step 1: Render external texture → sourceCopyTex
    this.writeCopyViewport(device, videoW, videoH);

    const copyBindGroup = device.createBindGroup({
      layout: copyBindGroupLayout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: externalTexture },
        { binding: 2, resource: { buffer: this.copyViewportBuffer } },
      ],
    });

    const copyPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.sourceCopyTex.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    copyPass.setPipeline(copyPipeline);
    copyPass.setBindGroup(0, copyBindGroup);
    copyPass.draw(4);
    copyPass.end();

    // Update uniforms
    this.specVqsrGenUniformData[0] = 1.0 / cw;
    this.specVqsrGenUniformData[1] = 1.0 / ch;
    this.specVqsrGenUniformData[2] = cw;
    this.specVqsrGenUniformData[3] = ch;
    this.specVqsrGenUniformData[4] = 5.0;
    this.specVqsrGenUniformData[5] = 0.6;
    this.specVqsrGenUniformData[6] = 0.0;
    this.specVqsrGenUniformData[7] = 0.0;
    device.queue.writeBuffer(this.specVqsrGenUniformBuffer, 0, this.specVqsrGenUniformData);

    const wg8X = Math.ceil(cw / 8);
    const wg8Y = Math.ceil(ch / 8);

    // Cache stable bind groups (recreated only on texture resize)
    if (!this.specCachedBGs) {
      this.specCachedBGs = {
        dctFwdBG0: device.createBindGroup({
          layout: spec.dctForward.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.specVqsrGenUniformBuffer } },
          ],
        }),
        dctFwdBG1: device.createBindGroup({
          layout: spec.dctForward.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: this.dctCoeffTex.createView() },
          ],
        }),
        hallBG0: device.createBindGroup({
          layout: spec.hallucinate.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.specVqsrGenUniformBuffer } },
          ],
        }),
        hallBG1: device.createBindGroup({
          layout: spec.hallucinate.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: this.dctCoeffTex.createView() },
            { binding: 1, resource: this.dctFilledTex.createView() },
          ],
        }),
        idctBG0: device.createBindGroup({
          layout: spec.dctInverse.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.specVqsrGenUniformBuffer } },
          ],
        }),
      };
    }
    const { dctFwdBG0, dctFwdBG1, hallBG0, hallBG1, idctBG0 } = this.specCachedBGs;

    // Step 2: Forward DCT
    const dctFwdPass = commandEncoder.beginComputePass();
    dctFwdPass.setPipeline(spec.dctForward);
    dctFwdPass.setBindGroup(0, dctFwdBG0);
    dctFwdPass.setBindGroup(1, dctFwdBG1);
    dctFwdPass.dispatchWorkgroups(wg8X, wg8Y);
    dctFwdPass.end();

    // Step 3: Hallucinate
    const hallPass = commandEncoder.beginComputePass();
    hallPass.setPipeline(spec.hallucinate);
    hallPass.setBindGroup(0, hallBG0);
    hallPass.setBindGroup(1, hallBG1);
    hallPass.dispatchWorkgroups(wg8X, wg8Y);
    hallPass.end();

    // Step 4: Inverse DCT + Blend → canvas (idctBG1 references canvasTex — must be per-frame)
    const canvasTex = this.gpuContext.getCurrentTexture();
    const idctBG1 = device.createBindGroup({
      layout: spec.dctInverse.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: this.dctFilledTex.createView() },
        { binding: 1, resource: canvasTex.createView() },
      ],
    });

    const idctPass = commandEncoder.beginComputePass();
    idctPass.setPipeline(spec.dctInverse);
    idctPass.setBindGroup(0, idctBG0);
    idctPass.setBindGroup(1, idctBG1);
    idctPass.dispatchWorkgroups(wg8X, wg8Y);
    idctPass.end();

    return commandEncoder.finish();
  }

  // ── VQSR Compute Encode ─────────────────────────────────────

  private encodeVQSR(
    device: GPUDevice,
    externalTexture: GPUExternalTexture,
    sampler: GPUSampler,
    videoW: number,
    videoH: number,
  ): GPUCommandBuffer | null {
    if (!this.gpu?.vqsr || !this.gpuContext) return null;
    const { vqsr, copyPipeline, copyBindGroupLayout } = this.gpu;

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ensureIntermediateTextures(device, cw, ch);
    this.ensureFloat32Textures(device, cw, ch);
    if (!this.sourceCopyTex || !this.featureTex || !this.detailTex ||
        !this.specVqsrGenUniformBuffer || !this.copyViewportBuffer) return null;

    const commandEncoder = device.createCommandEncoder();

    // Step 1: Render external texture → sourceCopyTex
    this.writeCopyViewport(device, videoW, videoH);

    const copyBindGroup = device.createBindGroup({
      layout: copyBindGroupLayout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: externalTexture },
        { binding: 2, resource: { buffer: this.copyViewportBuffer } },
      ],
    });

    const copyPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.sourceCopyTex.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    copyPass.setPipeline(copyPipeline);
    copyPass.setBindGroup(0, copyBindGroup);
    copyPass.draw(4);
    copyPass.end();

    // Update uniforms
    this.specVqsrGenUniformData[0] = 1.0 / cw;
    this.specVqsrGenUniformData[1] = 1.0 / ch;
    this.specVqsrGenUniformData[2] = cw;
    this.specVqsrGenUniformData[3] = ch;
    this.specVqsrGenUniformData[4] = 6.0;
    this.specVqsrGenUniformData[5] = 0.7;
    this.specVqsrGenUniformData[6] = 0.0;
    this.specVqsrGenUniformData[7] = 0.0;
    device.queue.writeBuffer(this.specVqsrGenUniformBuffer, 0, this.specVqsrGenUniformData);

    // VQSR dispatches at 1/4 resolution (one thread per 4×4 block)
    const wgEncX = Math.ceil(Math.ceil(cw / 4) / 8);
    const wgEncY = Math.ceil(Math.ceil(ch / 4) / 8);
    const wgFullX = Math.ceil(cw / 8);
    const wgFullY = Math.ceil(ch / 8);

    // Cache stable bind groups (recreated only on texture resize)
    if (!this.vqsrCachedBGs) {
      this.vqsrCachedBGs = {
        encBG0: device.createBindGroup({
          layout: vqsr.encode.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.specVqsrGenUniformBuffer } },
          ],
        }),
        encBG1: device.createBindGroup({
          layout: vqsr.encode.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: this.featureTex.createView() },
          ],
        }),
        lookBG0: device.createBindGroup({
          layout: vqsr.lookup.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.specVqsrGenUniformBuffer } },
          ],
        }),
        lookBG1: device.createBindGroup({
          layout: vqsr.lookup.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: this.featureTex.createView() },
            { binding: 1, resource: this.detailTex.createView() },
          ],
        }),
        blndBG0: device.createBindGroup({
          layout: vqsr.blend.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.specVqsrGenUniformBuffer } },
          ],
        }),
      };
    }
    const { encBG0, encBG1, lookBG0, lookBG1, blndBG0 } = this.vqsrCachedBGs;

    // Step 2: Feature encoding (1/4 resolution)
    const encPass = commandEncoder.beginComputePass();
    encPass.setPipeline(vqsr.encode);
    encPass.setBindGroup(0, encBG0);
    encPass.setBindGroup(1, encBG1);
    encPass.dispatchWorkgroups(wgEncX, wgEncY);
    encPass.end();

    // Step 3: Codebook lookup (1/4 resolution)
    const lookPass = commandEncoder.beginComputePass();
    lookPass.setPipeline(vqsr.lookup);
    lookPass.setBindGroup(0, lookBG0);
    lookPass.setBindGroup(1, lookBG1);
    lookPass.dispatchWorkgroups(wgEncX, wgEncY);
    lookPass.end();

    // Step 4: Edge-aware blend → canvas (blndBG1 references canvasTex — must be per-frame)
    const canvasTex = this.gpuContext.getCurrentTexture();
    const blndBG1 = device.createBindGroup({
      layout: vqsr.blend.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: this.detailTex.createView() },
        { binding: 1, resource: canvasTex.createView() },
      ],
    });

    const blndPass = commandEncoder.beginComputePass();
    blndPass.setPipeline(vqsr.blend);
    blndPass.setBindGroup(0, blndBG0);
    blndPass.setBindGroup(1, blndBG1);
    blndPass.dispatchWorkgroups(wgFullX, wgFullY);
    blndPass.end();

    return commandEncoder.finish();
  }

  // ── GEN Compute Encode ──────────────────────────────────────

  private encodeGEN(
    device: GPUDevice,
    externalTexture: GPUExternalTexture,
    sampler: GPUSampler,
    videoW: number,
    videoH: number,
  ): GPUCommandBuffer | null {
    if (!this.gpu?.gen || !this.gpuContext) return null;
    const { gen, copyPipeline, copyBindGroupLayout } = this.gpu;

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ensureIntermediateTextures(device, cw, ch);
    this.ensureFloat32Textures(device, cw, ch);
    if (!this.sourceCopyTex || !this.genResidualTex ||
        this.genFeatA.length < 4 || this.genFeatB.length < 4 ||
        !this.specVqsrGenUniformBuffer || !this.copyViewportBuffer) return null;

    const commandEncoder = device.createCommandEncoder();

    // Step 1: Render external texture → sourceCopyTex
    this.writeCopyViewport(device, videoW, videoH);

    const copyBindGroup = device.createBindGroup({
      layout: copyBindGroupLayout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: externalTexture },
        { binding: 2, resource: { buffer: this.copyViewportBuffer } },
      ],
    });

    const copyPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.sourceCopyTex.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    copyPass.setPipeline(copyPipeline);
    copyPass.setBindGroup(0, copyBindGroup);
    copyPass.draw(4);
    copyPass.end();

    const wg16X = Math.ceil(cw / 16);
    const wg16Y = Math.ceil(ch / 16);
    const wg8X = Math.ceil(cw / 8);
    const wg8Y = Math.ceil(ch / 8);

    // Dispatch 1: Feature extraction → genFeatA[0..3]
    this.specVqsrGenUniformData[0] = 1.0 / cw;
    this.specVqsrGenUniformData[1] = 1.0 / ch;
    this.specVqsrGenUniformData[2] = cw;
    this.specVqsrGenUniformData[3] = ch;
    this.specVqsrGenUniformData[4] = 7.0;
    this.specVqsrGenUniformData[5] = 0.7;
    this.specVqsrGenUniformData[6] = 0.0;
    this.specVqsrGenUniformData[7] = 0.0;
    device.queue.writeBuffer(this.specVqsrGenUniformBuffer, 0, this.specVqsrGenUniformData);

    // Cache stable bind groups (recreated only on texture resize)
    if (!this.genCachedBGs) {
      const rrdbBGs: { bg0: GPUBindGroup; bg1: GPUBindGroup }[] = [];
      for (let rrdbIdx = 0; rrdbIdx < 4; rrdbIdx++) {
        const inSet = rrdbIdx % 2 === 0 ? this.genFeatA : this.genFeatB;
        const outSet = rrdbIdx % 2 === 0 ? this.genFeatB : this.genFeatA;
        const rrdbUB = this.genRRDBUniformBuffers[rrdbIdx];
        rrdbBGs.push({
          bg0: device.createBindGroup({
            layout: gen.rrdb.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: this.sourceCopyTex.createView() },
              { binding: 1, resource: sampler },
              { binding: 2, resource: { buffer: rrdbUB } },
            ],
          }),
          bg1: device.createBindGroup({
            layout: gen.rrdb.getBindGroupLayout(1),
            entries: [
              { binding: 0, resource: inSet[0].createView() },
              { binding: 1, resource: inSet[1].createView() },
              { binding: 2, resource: inSet[2].createView() },
              { binding: 3, resource: inSet[3].createView() },
              { binding: 4, resource: outSet[0].createView() },
              { binding: 5, resource: outSet[1].createView() },
              { binding: 6, resource: outSet[2].createView() },
              { binding: 7, resource: outSet[3].createView() },
            ],
          }),
        });
      }
      const finalFeat = this.genFeatA;
      this.genCachedBGs = {
        feBG0: device.createBindGroup({
          layout: gen.featureExtract.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.specVqsrGenUniformBuffer } },
          ],
        }),
        feBG1: device.createBindGroup({
          layout: gen.featureExtract.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: this.genFeatA[0].createView() },
            { binding: 1, resource: this.genFeatA[1].createView() },
            { binding: 2, resource: this.genFeatA[2].createView() },
            { binding: 3, resource: this.genFeatA[3].createView() },
          ],
        }),
        rrdbBGs,
        reconBG0: device.createBindGroup({
          layout: gen.reconstruct.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.specVqsrGenUniformBuffer } },
          ],
        }),
        reconBG1: device.createBindGroup({
          layout: gen.reconstruct.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: finalFeat[0].createView() },
            { binding: 1, resource: finalFeat[1].createView() },
            { binding: 2, resource: finalFeat[2].createView() },
            { binding: 3, resource: finalFeat[3].createView() },
            { binding: 4, resource: this.genResidualTex.createView() },
          ],
        }),
        blendBG0: device.createBindGroup({
          layout: gen.blend.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.specVqsrGenUniformBuffer } },
          ],
        }),
      };
    }
    const { feBG0, feBG1, rrdbBGs, reconBG0, reconBG1, blendBG0 } = this.genCachedBGs;

    const fePass = commandEncoder.beginComputePass();
    fePass.setPipeline(gen.featureExtract);
    fePass.setBindGroup(0, feBG0);
    fePass.setBindGroup(1, feBG1);
    fePass.dispatchWorkgroups(wg16X, wg16Y);
    fePass.end();

    // Dispatches 2-5: 4× RRDB blocks, ping-pong between A↔B
    for (let rrdbIdx = 0; rrdbIdx < 4; rrdbIdx++) {
      // Write to per-RRDB uniform buffer so each dispatch sees its own rrdbIndex
      this.specVqsrGenUniformData[6] = rrdbIdx;
      const rrdbUB = this.genRRDBUniformBuffers[rrdbIdx];
      device.queue.writeBuffer(rrdbUB, 0, this.specVqsrGenUniformData);

      const { bg0, bg1 } = rrdbBGs[rrdbIdx];
      const rrdbPass = commandEncoder.beginComputePass();
      rrdbPass.setPipeline(gen.rrdb);
      rrdbPass.setBindGroup(0, bg0);
      rrdbPass.setBindGroup(1, bg1);
      rrdbPass.dispatchWorkgroups(wg16X, wg16Y);
      rrdbPass.end();
    }

    // Dispatch 6: Reconstruct 16ch → RGB residual
    const reconPass = commandEncoder.beginComputePass();
    reconPass.setPipeline(gen.reconstruct);
    reconPass.setBindGroup(0, reconBG0);
    reconPass.setBindGroup(1, reconBG1);
    reconPass.dispatchWorkgroups(wg16X, wg16Y);
    reconPass.end();

    // Dispatch 7: Blend residual + source → canvas (blendBG1 references canvasTex — must be per-frame)
    const canvasTex = this.gpuContext.getCurrentTexture();
    const blendBG1 = device.createBindGroup({
      layout: gen.blend.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: this.genResidualTex.createView() },
        { binding: 1, resource: canvasTex.createView() },
      ],
    });

    const blendPass = commandEncoder.beginComputePass();
    blendPass.setPipeline(gen.blend);
    blendPass.setBindGroup(0, blendBG0);
    blendPass.setBindGroup(1, blendBG1);
    blendPass.dispatchWorkgroups(wg8X, wg8Y);
    blendPass.end();

    return commandEncoder.finish();
  }

  // ── DLSS Texture Management ─────────────────────────────────

  /** Ensure DLSS temporal textures exist at the right size */
  private ensureDLSSTextures(device: GPUDevice, w: number, h: number): void {
    if (this.lastDlssW === w && this.lastDlssH === h && this.dlssPrevFrameTex) {
      return;
    }

    // Destroy old textures
    this.dlssPrevFrameTex?.destroy();
    this.dlssAccumTex?.destroy();
    this.dlssAccumOutTex?.destroy();
    this.dlssMotionVecTex?.destroy();
    this.dlssDepthHintsTex?.destroy();
    this.dlssEnhancedTex?.destroy();

    const rgbaUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING |
                      GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;

    this.dlssPrevFrameTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: rgbaUsage,
    });

    this.dlssAccumTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: rgbaUsage,
    });

    this.dlssAccumOutTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING |
             GPUTextureUsage.COPY_SRC,
    });

    this.dlssMotionVecTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rg32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    this.dlssDepthHintsTex = device.createTexture({
      size: { width: w, height: h },
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    this.dlssEnhancedTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    if (!this.dlssUniformBuffer) {
      this.dlssUniformBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    this.lastDlssW = w;
    this.lastDlssH = h;
    this.dlssFrameCount = 0;
    this.dlssCachedBGs = null;
  }

  // ── DLSS Compute Encode ─────────────────────────────────────

  /**
   * Encode DLSS compute passes:
   * external texture → sourceCopy → motion+depth → temporal accum →
   * spatial enhance → final reconstruct → canvas.
   */
  private encodeDLSS(
    device: GPUDevice,
    externalTexture: GPUExternalTexture,
    sampler: GPUSampler,
    videoW: number,
    videoH: number,
  ): GPUCommandBuffer | null {
    if (!this.gpu?.dlss || !this.gpuContext) return null;
    const { dlss, copyPipeline, copyBindGroupLayout } = this.gpu;

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ensureIntermediateTextures(device, cw, ch);
    this.ensureDLSSTextures(device, cw, ch);
    if (!this.sourceCopyTex || !this.dlssPrevFrameTex || !this.dlssAccumTex ||
        !this.dlssAccumOutTex || !this.dlssMotionVecTex || !this.dlssDepthHintsTex ||
        !this.dlssEnhancedTex || !this.dlssUniformBuffer || !this.copyViewportBuffer) return null;

    const commandEncoder = device.createCommandEncoder();

    // Step 1: Render external texture → sourceCopyTex (bilinear, mode=0)
    this.writeCopyViewport(device, videoW, videoH);

    const copyBindGroup = device.createBindGroup({
      layout: copyBindGroupLayout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: externalTexture },
        { binding: 2, resource: { buffer: this.copyViewportBuffer } },
      ],
    });

    const copyPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.sourceCopyTex.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    copyPass.setPipeline(copyPipeline);
    copyPass.setBindGroup(0, copyBindGroup);
    copyPass.draw(4);
    copyPass.end();

    // Update DLSS uniforms
    this.dlssUniformData[0] = 1.0 / cw;
    this.dlssUniformData[1] = 1.0 / ch;
    this.dlssUniformData[2] = cw;
    this.dlssUniformData[3] = ch;
    this.dlssUniformData[4] = this.dlssFrameCount;
    this.dlssUniformData[5] = 0.75; // sharpness
    this.dlssUniformData[6] = 0.85; // temporalWeight
    this.dlssUniformData[7] = 0.3;  // sceneCutThresh
    device.queue.writeBuffer(this.dlssUniformBuffer, 0, this.dlssUniformData);

    const wgX = Math.ceil(cw / 8);
    const wgY = Math.ceil(ch / 8);

    // Cache stable bind groups (recreated only on texture resize)
    if (!this.dlssCachedBGs) {
      this.dlssCachedBGs = {
        motionBG0: device.createBindGroup({
          layout: dlss.motionDepth.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.dlssUniformBuffer } },
          ],
        }),
        motionBG1: device.createBindGroup({
          layout: dlss.motionDepth.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: this.dlssPrevFrameTex.createView() },
            { binding: 1, resource: this.dlssMotionVecTex.createView() },
            { binding: 2, resource: this.dlssDepthHintsTex.createView() },
          ],
        }),
        accumBG0: device.createBindGroup({
          layout: dlss.temporalAccum.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.dlssUniformBuffer } },
          ],
        }),
        accumBG1: device.createBindGroup({
          layout: dlss.temporalAccum.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: this.dlssMotionVecTex.createView() },
            { binding: 1, resource: this.dlssDepthHintsTex.createView() },
            { binding: 2, resource: this.dlssAccumTex.createView() },
            { binding: 3, resource: this.dlssAccumOutTex.createView() },
          ],
        }),
        spatialBG0: device.createBindGroup({
          layout: dlss.spatialEnhance.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.dlssUniformBuffer } },
          ],
        }),
        spatialBG1: device.createBindGroup({
          layout: dlss.spatialEnhance.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: this.dlssAccumOutTex.createView() },
            { binding: 1, resource: this.dlssDepthHintsTex.createView() },
            { binding: 2, resource: this.dlssEnhancedTex.createView() },
          ],
        }),
        finalBG0: device.createBindGroup({
          layout: dlss.finalReconstruct.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sourceCopyTex.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: this.dlssUniformBuffer } },
          ],
        }),
      };
    }
    const { motionBG0, motionBG1, accumBG0, accumBG1, spatialBG0, spatialBG1, finalBG0 } = this.dlssCachedBGs;

    // Step 2: Motion estimation + depth hints
    const motionPass = commandEncoder.beginComputePass();
    motionPass.setPipeline(dlss.motionDepth);
    motionPass.setBindGroup(0, motionBG0);
    motionPass.setBindGroup(1, motionBG1);
    motionPass.dispatchWorkgroups(wgX, wgY);
    motionPass.end();

    // Step 3: Temporal accumulation
    const accumPass = commandEncoder.beginComputePass();
    accumPass.setPipeline(dlss.temporalAccum);
    accumPass.setBindGroup(0, accumBG0);
    accumPass.setBindGroup(1, accumBG1);
    accumPass.dispatchWorkgroups(wgX, wgY);
    accumPass.end();

    // Copy accumOut → accumTex for next frame
    commandEncoder.copyTextureToTexture(
      { texture: this.dlssAccumOutTex },
      { texture: this.dlssAccumTex },
      { width: cw, height: ch },
    );

    // Step 4: Spatial enhancement
    const spatialPass = commandEncoder.beginComputePass();
    spatialPass.setPipeline(dlss.spatialEnhance);
    spatialPass.setBindGroup(0, spatialBG0);
    spatialPass.setBindGroup(1, spatialBG1);
    spatialPass.dispatchWorkgroups(wgX, wgY);
    spatialPass.end();

    // Step 5: Final reconstruction → canvas (finalBG1 references canvasTex — must be per-frame)
    const canvasTex = this.gpuContext.getCurrentTexture();
    const finalBG1 = device.createBindGroup({
      layout: dlss.finalReconstruct.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: this.dlssEnhancedTex.createView() },
        { binding: 1, resource: this.dlssAccumOutTex.createView() },
        { binding: 2, resource: canvasTex.createView() },
      ],
    });

    const finalPass = commandEncoder.beginComputePass();
    finalPass.setPipeline(dlss.finalReconstruct);
    finalPass.setBindGroup(0, finalBG0);
    finalPass.setBindGroup(1, finalBG1);
    finalPass.dispatchWorkgroups(wgX, wgY);
    finalPass.end();

    // Step 6: Copy sourceCopyTex → prevFrameTex for next frame's motion estimation
    commandEncoder.copyTextureToTexture(
      { texture: this.sourceCopyTex },
      { texture: this.dlssPrevFrameTex },
      { width: cw, height: ch },
    );

    this.dlssFrameCount++;

    return commandEncoder.finish();
  }

  /**
   * Draw a decoded VideoFrame, submit immediately, and close it.
   *
   * For multi-stream batching, use encodeFrame() + device.queue.submit()
   * + frame.close() instead.
   */
  drawFrame(frame: VideoFrame): void {
    const cmdBuf = this.encodeFrame(frame);
    if (cmdBuf && this.gpu) {
      this.gpu.device.queue.submit([cmdBuf]);
    }
    try { frame.close(); } catch { /* already closed */ }
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

    // Clear cached compute bind groups
    this.tsrCachedBGs = null;
    this.specCachedBGs = null;
    this.vqsrCachedBGs = null;
    this.genCachedBGs = null;
    this.dlssCachedBGs = null;
    this.a4kCachedBlitBG = null;

    // Destroy intermediate textures
    this.sourceCopyTex?.destroy();
    this.intermediateA?.destroy();
    this.intermediateB?.destroy();
    this.sourceCopyTex = null;
    this.intermediateA = null;
    this.intermediateB = null;
    this.copyViewportBuffer?.destroy();
    this.copyViewportBuffer = null;
    this.lastIntermediateW = 0;
    this.lastIntermediateH = 0;

    // Destroy anime4k-webgpu pipeline and its internal GPU textures
    this.destroyA4KPipelineTextures();
    this.a4kInputW = 0;
    this.a4kInputH = 0;
    this.a4kCurrentMode = null;

    // Destroy TSR temporal textures
    this.prevFrameTex?.destroy();
    this.accumTex?.destroy();
    this.motionVecTex?.destroy();
    this.prevFrameTex = null;
    this.accumTex = null;
    this.motionVecTex = null;
    this.tsrUniformBuffer?.destroy();
    this.tsrUniformBuffer = null;
    this.tsrFrameCount = 0;

    // Destroy SPEC/VQSR/GEN float32 textures
    this.dctCoeffTex?.destroy();
    this.dctFilledTex?.destroy();
    this.featureTex?.destroy();
    this.detailTex?.destroy();
    this.genResidualTex?.destroy();
    for (const t of this.genFeatA) t.destroy();
    for (const t of this.genFeatB) t.destroy();
    this.dctCoeffTex = null;
    this.dctFilledTex = null;
    this.featureTex = null;
    this.detailTex = null;
    this.genResidualTex = null;
    this.genFeatA = [];
    this.genFeatB = [];
    this.specVqsrGenUniformBuffer?.destroy();
    this.specVqsrGenUniformBuffer = null;
    for (const buf of this.genRRDBUniformBuffers) buf.destroy();
    this.genRRDBUniformBuffers = [];
    this.lastFloat32W = 0;
    this.lastFloat32H = 0;

    // Destroy DLSS textures
    this.dlssPrevFrameTex?.destroy();
    this.dlssAccumTex?.destroy();
    this.dlssAccumOutTex?.destroy();
    this.dlssMotionVecTex?.destroy();
    this.dlssDepthHintsTex?.destroy();
    this.dlssEnhancedTex?.destroy();
    this.dlssPrevFrameTex = null;
    this.dlssAccumTex = null;
    this.dlssAccumOutTex = null;
    this.dlssMotionVecTex = null;
    this.dlssDepthHintsTex = null;
    this.dlssEnhancedTex = null;
    this.dlssUniformBuffer?.destroy();
    this.dlssUniformBuffer = null;
    this.dlssFrameCount = 0;
    this.lastDlssW = 0;
    this.lastDlssH = 0;

    this.ctx2d = null;
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
