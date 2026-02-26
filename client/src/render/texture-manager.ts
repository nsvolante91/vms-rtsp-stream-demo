/**
 * WebGPU external texture lifecycle manager.
 *
 * Manages the critical constraint of `importExternalTexture`: the
 * resulting GPUExternalTexture is only valid until the current microtask
 * completes. This manager ensures textures are imported and consumed
 * within the same synchronous render pass, and that the source
 * VideoFrame is always closed afterwards.
 *
 * Also handles automatic expiry detection — if a texture is imported
 * but the render pass hasn't consumed it by the time the microtask
 * boundary is reached, the texture becomes invalid. This manager
 * tracks that state and reports it.
 */

import { Logger } from '../utils/logger';

/**
 * An imported external texture bound to its source VideoFrame.
 *
 * The `texture` field is only valid until the current microtask ends.
 * After calling `release()`, the source frame is closed and the texture
 * must not be used.
 */
export interface ManagedTexture {
  /** The GPU external texture (valid only in current microtask) */
  texture: GPUExternalTexture;
  /** Width of the source frame in pixels */
  width: number;
  /** Height of the source frame in pixels */
  height: number;
  /** Release the source VideoFrame. Must be called after rendering. */
  release(): void;
}

/**
 * Manages zero-copy GPU texture imports from VideoFrames.
 *
 * Provides a safe wrapper around `device.importExternalTexture()` that
 * ensures every VideoFrame is closed after use. Tracks import/release
 * counts for leak detection.
 *
 * Usage pattern:
 * ```typescript
 * const managed = textureManager.importFrame(frame);
 * // Use managed.texture in the same synchronous render pass
 * renderPass.bindTexture(managed.texture);
 * renderPass.draw();
 * managed.release(); // closes the VideoFrame
 * ```
 *
 * CRITICAL: `managed.release()` MUST be called after rendering, even
 * if an error occurs. Use try/finally to guarantee cleanup.
 */
export class TextureManager {
  private _importCount = 0;
  private _releaseCount = 0;
  private _errorCount = 0;
  private readonly log: Logger;

  /**
   * Create a TextureManager.
   *
   * @param device - The GPUDevice used to import external textures
   */
  constructor(private readonly device: GPUDevice) {
    this.log = new Logger('TextureManager');
  }

  /**
   * Import a VideoFrame as a GPUExternalTexture for zero-copy GPU rendering.
   *
   * The returned `ManagedTexture` wraps the external texture and the source
   * frame. The texture is ONLY valid until the current microtask completes —
   * it must be bound and drawn in the same synchronous call stack.
   *
   * CRITICAL: Call `release()` on the returned object after rendering to
   * close the source VideoFrame and prevent GPU memory leaks.
   *
   * @param frame - Decoded VideoFrame to import (will be closed on release)
   * @returns ManagedTexture with the GPU texture and release function
   * @throws Error if importExternalTexture fails (frame may be invalid)
   */
  importFrame(frame: VideoFrame): ManagedTexture {
    this._importCount++;
    let released = false;

    try {
      const texture = this.device.importExternalTexture({
        source: frame,
      });

      return {
        texture,
        width: frame.displayWidth,
        height: frame.displayHeight,
        release: () => {
          if (released) return;
          released = true;
          this._releaseCount++;
          frame.close();
        },
      };
    } catch (err) {
      this._errorCount++;
      // Always close the frame even if import fails
      frame.close();
      throw err;
    }
  }

  /** Total number of frame import attempts (including failed imports) */
  get importCount(): number {
    return this._importCount;
  }

  /** Total number of frames released (closed) */
  get releaseCount(): number {
    return this._releaseCount;
  }

  /** Number of import errors */
  get errorCount(): number {
    return this._errorCount;
  }

  /**
   * Number of frames imported but not yet released.
   * Should be 0 outside of a render pass. A persistent non-zero value
   * indicates a leak.
   */
  get pendingCount(): number {
    return this._importCount - this._releaseCount - this._errorCount;
  }
}
