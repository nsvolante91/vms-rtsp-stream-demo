/**
 * Automated benchmark runner for progressive stream load testing.
 *
 * Incrementally adds video streams, stabilizes, measures performance,
 * and reports the maximum number of streams sustainable above an FPS
 * threshold.
 */

import { Logger } from '../utils/logger';
import type { MetricsCollector } from './metrics-collector';

/** Configuration for a benchmark run */
export interface BenchmarkConfig {
  /** Maximum number of streams to test */
  maxStreams: number;
  /** Time to wait for stream stabilization in milliseconds */
  stabilizeMs: number;
  /** Duration to measure performance in milliseconds */
  measureMs: number;
  /** Minimum average FPS per stream to consider sustainable */
  fpsThreshold: number;
}

/** Metrics captured for a single stream-count step */
export interface BenchmarkStep {
  /** Number of active streams during this step */
  streamCount: number;
  /** Average FPS per stream */
  avgFps: number;
  /** Minimum FPS among all streams */
  minFps: number;
  /** Maximum FPS among all streams */
  maxFps: number;
  /** Average decode time in milliseconds */
  avgDecodeMs: number;
  /** Total dropped frames across all streams */
  droppedFrames: number;
  /** JavaScript heap memory usage in megabytes */
  memoryMB: number;
}

/** Complete benchmark report */
export interface BenchmarkReport {
  /** ISO timestamp of when the benchmark was run */
  timestamp: string;
  /** Browser user agent string */
  userAgent: string;
  /** GPU information string */
  gpuInfo: string;
  /** Array of measurement steps, one per stream count */
  steps: BenchmarkStep[];
  /** Maximum number of streams that sustained above the FPS threshold */
  maxSustainableStreams: number;
}

/** Default benchmark configuration */
const DEFAULT_CONFIG: BenchmarkConfig = {
  maxStreams: 16,
  stabilizeMs: 3000,
  measureMs: 5000,
  fpsThreshold: 20,
};

/**
 * Progressive benchmark runner.
 *
 * Adds streams one at a time, waits for stabilization, measures
 * performance metrics over a measurement window, and continues
 * until FPS drops below the threshold or the maximum stream count
 * is reached. Produces a detailed report suitable for comparison.
 */
export class BenchmarkRunner {
  private aborted = false;
  private running = false;
  private readonly log: Logger;

  /**
   * Create a new BenchmarkRunner.
   * @param addStream - Async function that adds one stream to the system
   * @param removeAllStreams - Function that removes all active streams
   * @param metrics - MetricsCollector to read performance data from
   * @param gpuInfo - GPU information string for the report
   */
  constructor(
    private readonly addStream: () => Promise<void>,
    private readonly removeAllStreams: () => void,
    private readonly metrics: MetricsCollector,
    private readonly gpuInfo: string
  ) {
    this.log = new Logger('Benchmark');
  }

  /**
   * Run the progressive benchmark.
   *
   * Steps:
   * 1. Remove all existing streams and reset metrics
   * 2. For each stream count from 1 to maxStreams:
   *    a. Add one stream
   *    b. Wait stabilizeMs for the stream to stabilize
   *    c. Reset metrics counters
   *    d. Measure for measureMs
   *    e. Record metrics
   *    f. If average FPS per stream drops below threshold, stop
   * 3. Compile and return the benchmark report
   *
   * @param config - Optional partial configuration overrides
   * @returns Complete benchmark report
   */
  async run(config?: Partial<BenchmarkConfig>): Promise<BenchmarkReport> {
    if (this.running) {
      throw new Error('Benchmark already running');
    }

    this.running = true;
    this.aborted = false;

    const cfg: BenchmarkConfig = { ...DEFAULT_CONFIG, ...config };
    const steps: BenchmarkStep[] = [];
    let maxSustainableStreams = 0;

    this.log.info(`Starting benchmark: max=${cfg.maxStreams}, stabilize=${cfg.stabilizeMs}ms, measure=${cfg.measureMs}ms, threshold=${cfg.fpsThreshold} FPS`);

    // Clean slate
    this.removeAllStreams();
    this.metrics.reset();

    try {
      for (let streamCount = 1; streamCount <= cfg.maxStreams; streamCount++) {
        if (this.aborted) {
          this.log.info('Benchmark aborted');
          break;
        }

        this.log.info(`Step ${streamCount}: adding stream`);
        await this.addStream();

        // Wait for stabilization
        await this.delay(cfg.stabilizeMs);
        if (this.aborted) break;

        // Reset metrics for clean measurement
        this.metrics.reset();

        // Measure
        await this.delay(cfg.measureMs);
        if (this.aborted) break;

        // Collect metrics
        const global = this.metrics.getGlobalMetrics();
        const avgFps = global.activeStreams > 0 ? global.totalFps / global.activeStreams : 0;

        // Collect per-stream FPS for min/max
        let minFps = Infinity;
        let maxFps = 0;
        let totalDecodeMs = 0;
        let totalDropped = 0;

        // Read stream metrics from the JSON export
        const jsonStr = this.metrics.exportJSON();
        const jsonData = JSON.parse(jsonStr) as {
          streams: Array<{ streamId: number; fps: number; decodeTimeMs: number; droppedFrames: number }>;
        };

        for (const sm of jsonData.streams) {
          if (sm.fps < minFps) minFps = sm.fps;
          if (sm.fps > maxFps) maxFps = sm.fps;
          totalDecodeMs += sm.decodeTimeMs;
          totalDropped += sm.droppedFrames;
        }

        if (minFps === Infinity) minFps = 0;

        const avgDecodeMs = jsonData.streams.length > 0 ? totalDecodeMs / jsonData.streams.length : 0;

        const step: BenchmarkStep = {
          streamCount,
          avgFps: Math.round(avgFps * 10) / 10,
          minFps,
          maxFps,
          avgDecodeMs: Math.round(avgDecodeMs * 100) / 100,
          droppedFrames: totalDropped,
          memoryMB: Math.round(global.jsHeapUsedMB * 10) / 10,
        };

        steps.push(step);
        this.log.info(`Step ${streamCount}: avgFPS=${step.avgFps}, minFPS=${step.minFps}, dropped=${step.droppedFrames}`);

        if (avgFps >= cfg.fpsThreshold) {
          maxSustainableStreams = streamCount;
        } else {
          this.log.info(`FPS ${avgFps.toFixed(1)} below threshold ${cfg.fpsThreshold}, stopping`);
          break;
        }
      }
    } finally {
      this.running = false;
    }

    const report: BenchmarkReport = {
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      gpuInfo: this.gpuInfo,
      steps,
      maxSustainableStreams,
    };

    this.log.info(`Benchmark complete: max sustainable streams = ${maxSustainableStreams}`);
    return report;
  }

  /**
   * Abort a running benchmark.
   *
   * The current measurement step will complete, and the benchmark
   * will return partial results.
   */
  abort(): void {
    if (this.running) {
      this.aborted = true;
      this.log.info('Abort requested');
    }
  }

  /** Whether a benchmark is currently running */
  get isRunning(): boolean {
    return this.running;
  }

  /** Promise-based delay that respects abort */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      window.setTimeout(resolve, ms);
    });
  }
}
