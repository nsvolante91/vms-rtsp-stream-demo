/**
 * Performance metrics collector for video streaming.
 *
 * Tracks per-stream and global performance metrics including FPS,
 * decode times, dropped frames, bitrates, and memory usage.
 * Supports export to JSON and CSV for analysis.
 */

/** Performance metrics for a single video stream */
export interface StreamMetrics {
  /** Stream identifier */
  streamId: number;
  /** Frames per second (measured over the last 1-second window) */
  fps: number;
  /** Average decode time in milliseconds */
  decodeTimeMs: number;
  /** Total number of dropped frames */
  droppedFrames: number;
  /** Total number of decoded frames */
  decodedFrames: number;
  /** Current decode queue size */
  queueSize: number;
  /** Estimated bitrate in kilobits per second */
  bitrateKbps: number;
}

/** Aggregate performance metrics across all streams */
export interface GlobalMetrics {
  /** Total frames per second across all streams */
  totalFps: number;
  /** JavaScript heap usage in megabytes (Chrome only) */
  jsHeapUsedMB: number;
  /** Number of currently active streams */
  activeStreams: number;
  /** Total bandwidth across all streams in megabits per second */
  totalBandwidthMbps: number;
  /** Longest single-frame processing time in milliseconds */
  longestFrameMs: number;
  /** Time spent in the render pass in milliseconds */
  renderTimeMs: number;
}

/** Internal per-stream tracking data */
interface StreamData {
  frameTimes: number[];
  decodeTimes: number[];
  byteCounts: number[];
  byteTimestamps: number[];
  droppedFrames: number;
  decodedFrames: number;
  queueSize: number;
}

/** Internal global tracking data */
interface GlobalData {
  renderTimes: number[];
  longestFrameMs: number;
}

/** Window size for FPS calculation in milliseconds */
const FPS_WINDOW_MS = 1_000;

/** Window size for bitrate calculation in milliseconds */
const BITRATE_WINDOW_MS = 2_000;

/**
 * Collects and computes performance metrics for the VMS application.
 *
 * Uses performance.now() for all timing measurements. FPS is computed
 * as the number of frames recorded in the last 1-second window.
 * Memory usage is read from performance.memory (Chrome-only API).
 */
export class MetricsCollector {
  private readonly streamData: Map<number, StreamData> = new Map();
  private globalData: GlobalData = { renderTimes: [], longestFrameMs: 0 };

  /**
   * Get or create the internal tracking data for a stream.
   * @param streamId - Stream identifier
   * @returns Internal stream tracking data
   */
  private getStream(streamId: number): StreamData {
    let data = this.streamData.get(streamId);
    if (!data) {
      data = {
        frameTimes: [],
        decodeTimes: [],
        byteCounts: [],
        byteTimestamps: [],
        droppedFrames: 0,
        decodedFrames: 0,
        queueSize: 0,
      };
      this.streamData.set(streamId, data);
    }
    return data;
  }

  /**
   * Record a decoded frame for a stream.
   * @param streamId - Stream that produced the frame
   */
  recordFrame(streamId: number): void {
    const data = this.getStream(streamId);
    data.frameTimes.push(performance.now());
    data.decodedFrames++;
  }

  /**
   * Record a dropped frame for a stream.
   * @param streamId - Stream that dropped the frame
   */
  recordDrop(streamId: number): void {
    const data = this.getStream(streamId);
    data.droppedFrames++;
  }

  /**
   * Record the time taken to decode a single frame.
   * @param streamId - Stream that was decoded
   * @param ms - Decode time in milliseconds
   */
  recordDecodeTime(streamId: number, ms: number): void {
    const data = this.getStream(streamId);
    data.decodeTimes.push(ms);

    // Keep only recent decode times (last 60 entries)
    if (data.decodeTimes.length > 60) {
      data.decodeTimes.shift();
    }
  }

  /**
   * Record the time spent in the GPU render pass.
   * @param ms - Render time in milliseconds
   */
  recordRenderTime(ms: number): void {
    this.globalData.renderTimes.push(ms);
    if (ms > this.globalData.longestFrameMs) {
      this.globalData.longestFrameMs = ms;
    }

    // Keep only recent render times
    if (this.globalData.renderTimes.length > 60) {
      this.globalData.renderTimes.shift();
    }
  }

  /**
   * Record bytes received for a stream (for bitrate calculation).
   * @param streamId - Stream that received the data
   * @param bytes - Number of bytes received
   */
  recordBytes(streamId: number, bytes: number): void {
    const data = this.getStream(streamId);
    data.byteCounts.push(bytes);
    data.byteTimestamps.push(performance.now());

    // Trim old byte records
    const cutoff = performance.now() - BITRATE_WINDOW_MS;
    while (data.byteTimestamps.length > 0 && data.byteTimestamps[0] < cutoff) {
      data.byteTimestamps.shift();
      data.byteCounts.shift();
    }
  }

  /**
   * Update the current decode queue size for a stream.
   * @param streamId - Stream identifier
   * @param size - Current queue size
   */
  updateQueueSize(streamId: number, size: number): void {
    const data = this.getStream(streamId);
    data.queueSize = size;
  }

  /**
   * Get performance metrics for a specific stream.
   * @param streamId - Stream identifier
   * @returns Current metrics snapshot for the stream
   */
  getStreamMetrics(streamId: number): StreamMetrics {
    const data = this.getStream(streamId);
    const now = performance.now();

    // Prune old frame times outside the FPS window
    const fpsCutoff = now - FPS_WINDOW_MS;
    while (data.frameTimes.length > 0 && data.frameTimes[0] < fpsCutoff) {
      data.frameTimes.shift();
    }

    const fps = data.frameTimes.length;

    // Average decode time
    const decodeTimeMs = data.decodeTimes.length > 0
      ? data.decodeTimes.reduce((a, b) => a + b, 0) / data.decodeTimes.length
      : 0;

    // Bitrate calculation
    const totalBytes = data.byteCounts.reduce((a, b) => a + b, 0);
    const bitrateWindow = data.byteTimestamps.length > 1
      ? (data.byteTimestamps[data.byteTimestamps.length - 1] - data.byteTimestamps[0]) / 1000
      : 1;
    const bitrateKbps = bitrateWindow > 0 ? (totalBytes * 8) / bitrateWindow / 1000 : 0;

    return {
      streamId,
      fps,
      decodeTimeMs,
      droppedFrames: data.droppedFrames,
      decodedFrames: data.decodedFrames,
      queueSize: data.queueSize,
      bitrateKbps,
    };
  }

  /**
   * Get aggregate performance metrics across all streams.
   * @returns Current global metrics snapshot
   */
  getGlobalMetrics(): GlobalMetrics {
    let totalFps = 0;
    let totalBandwidthKbps = 0;
    let activeStreams = 0;

    for (const streamId of this.streamData.keys()) {
      const sm = this.getStreamMetrics(streamId);
      totalFps += sm.fps;
      totalBandwidthKbps += sm.bitrateKbps;
      if (sm.fps > 0) {
        activeStreams++;
      }
    }

    // Average render time
    const renderTimeMs = this.globalData.renderTimes.length > 0
      ? this.globalData.renderTimes.reduce((a, b) => a + b, 0) / this.globalData.renderTimes.length
      : 0;

    // JS heap memory (Chrome only)
    let jsHeapUsedMB = 0;
    const perfMemory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (perfMemory) {
      jsHeapUsedMB = perfMemory.usedJSHeapSize / (1024 * 1024);
    }

    return {
      totalFps,
      jsHeapUsedMB,
      activeStreams,
      totalBandwidthMbps: totalBandwidthKbps / 1000,
      longestFrameMs: this.globalData.longestFrameMs,
      renderTimeMs,
    };
  }

  /**
   * Export all current metrics as a JSON string.
   * @returns JSON string containing global and per-stream metrics
   */
  exportJSON(): string {
    const global = this.getGlobalMetrics();
    const streams: StreamMetrics[] = [];
    for (const streamId of this.streamData.keys()) {
      streams.push(this.getStreamMetrics(streamId));
    }
    return JSON.stringify({ timestamp: new Date().toISOString(), global, streams }, null, 2);
  }

  /**
   * Export per-stream metrics as CSV.
   * @returns CSV string with header row and one data row per stream
   */
  exportCSV(): string {
    const headers = ['streamId', 'fps', 'decodeTimeMs', 'droppedFrames', 'decodedFrames', 'queueSize', 'bitrateKbps'];
    const rows = [headers.join(',')];

    for (const streamId of this.streamData.keys()) {
      const m = this.getStreamMetrics(streamId);
      rows.push([
        m.streamId,
        m.fps.toFixed(1),
        m.decodeTimeMs.toFixed(2),
        m.droppedFrames,
        m.decodedFrames,
        m.queueSize,
        m.bitrateKbps.toFixed(1),
      ].join(','));
    }

    return rows.join('\n');
  }

  /**
   * Remove tracking data for a specific stream.
   * @param streamId - Stream to remove
   */
  removeStream(streamId: number): void {
    this.streamData.delete(streamId);
  }

  /**
   * Reset all metrics to initial state.
   */
  reset(): void {
    this.streamData.clear();
    this.globalData = { renderTimes: [], longestFrameMs: 0 };
  }
}
