/**
 * UI control handlers for the VMS application.
 *
 * Binds event handlers to the HTML control bar buttons for layout
 * switching, stream management, benchmarking, metrics export,
 * and dashboard toggling.
 */

import type { UpscaleMode } from '../worker/messages';

/**
 * Binds UI event handlers to the control bar DOM elements.
 *
 * Expected DOM structure (from index.html):
 * - Layout buttons: `button[data-layout]` with values "1", "2", "3", "4"
 * - Add stream: `#btn-add-stream`
 * - Remove stream: `#btn-remove-stream`
 * - Benchmark: `#btn-benchmark`
 * - Export: `#btn-export`
 * - Dashboard toggle: "D" key press
 */
export class Controls {
  private cpuHogInterval: number | null = null;
  private secondaryVisible = false;

  /**
   * Create a new Controls instance.
   * @param onLayoutChange - Called with the number of columns when a layout button is clicked
   * @param onAddStream - Called when the "Add Stream" button is clicked
   * @param onRemoveStream - Called when the "Remove Stream" button is clicked
   * @param onBenchmark - Called when the "Run Benchmark" button is clicked
   * @param onExport - Called when the "Export Metrics" button is clicked
   * @param onToggleDashboard - Called when the dashboard toggle key is pressed
   */
  constructor(
    private readonly onLayoutChange: (columns: number) => void,
    private readonly onAddStream: () => void,
    private readonly onRemoveStream: () => void,
    private readonly onBenchmark: () => void,
    private readonly onExport: () => void,
    private readonly onToggleDashboard: () => void,
    private readonly onUpscaleChange?: (mode: UpscaleMode) => void,
    private readonly onToggleMetricsOverlay?: () => void,
    private readonly onResetMetrics?: () => void,
    private readonly onToggleCompare?: () => void
  ) {}

  /**
   * Initialize all event bindings.
   *
   * Queries the DOM for control elements and attaches click/keydown
   * handlers. Layout buttons get an "active" class toggle so only
   * the currently selected layout button is highlighted.
   */
  init(): void {
    // Layout buttons
    const layoutButtons = document.querySelectorAll<HTMLButtonElement>('.layout-btn');
    layoutButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const columns = parseInt(btn.dataset.layout ?? '2', 10);

        // Update active state
        layoutButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        this.onLayoutChange(columns);
      });
    });

    // Add stream button
    const addBtn = document.getElementById('btn-add-stream');
    if (addBtn) {
      addBtn.addEventListener('click', () => this.onAddStream());
    }

    // Remove stream button
    const removeBtn = document.getElementById('btn-remove-stream');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => this.onRemoveStream());
    }

    // Benchmark button
    const benchmarkBtn = document.getElementById('btn-benchmark');
    if (benchmarkBtn) {
      benchmarkBtn.addEventListener('click', () => this.onBenchmark());
    }

    // Export button
    const exportBtn = document.getElementById('btn-export');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.onExport());
    }

    // Reset metrics button
    const resetBtn = document.getElementById('btn-reset-metrics');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.onResetMetrics?.());
    }

    // CPU Hogger button
    const cpuHogBtn = document.getElementById('btn-cpu-hog');
    if (cpuHogBtn) {
      cpuHogBtn.addEventListener('click', () => this.toggleCpuHog(cpuHogBtn));
    }

    // Compare mode toggle button
    const compareBtn = document.getElementById('btn-compare');
    if (compareBtn) {
      compareBtn.addEventListener('click', () => {
        compareBtn.classList.toggle('active');
        this.onToggleCompare?.();
      });
    }

    // Metrics overlay toggle button
    const metricsOverlayBtn = document.getElementById('btn-metrics-overlay');
    if (metricsOverlayBtn) {
      metricsOverlayBtn.addEventListener('click', () => {
        metricsOverlayBtn.classList.toggle('active');
        this.onToggleMetricsOverlay?.();
      });
    }

    // Upscale dropdown
    const upscaleSelect = document.getElementById('upscale-select') as HTMLSelectElement | null;
    if (upscaleSelect) {
      upscaleSelect.addEventListener('change', () => {
        const mode = upscaleSelect.value as typeof Controls.UPSCALE_MODES[number];
        const infoEl = document.getElementById('upscale-info');
        if (infoEl) {
          infoEl.textContent = Controls.UPSCALE_DESCRIPTIONS[mode];
          infoEl.dataset.mode = mode;
        }
        upscaleSelect.dataset.mode = mode;
        console.log(`[Upscale] Mode: ${mode}`);
        this.onUpscaleChange?.(mode);
      });
    }

    // "More" toggle for secondary controls on mobile
    const moreBtn = document.getElementById('btn-more');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        this.secondaryVisible = !this.secondaryVisible;
        const secondary = document.querySelector('.control-secondary');
        if (secondary) {
          secondary.classList.toggle('visible', this.secondaryVisible);
        }
        moreBtn.textContent = this.secondaryVisible ? 'Less ▴' : 'More ▾';
      });
    }

    // Fullscreen toggle button
    const fullscreenBtn = document.getElementById('btn-fullscreen');
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          document.documentElement.requestFullscreen().catch(() => {
            // Fullscreen not supported or denied
          });
        }
      });

      document.addEventListener('fullscreenchange', () => {
        fullscreenBtn.textContent = document.fullscreenElement ? '⛶' : '⛶';
        fullscreenBtn.title = document.fullscreenElement ? 'Exit fullscreen' : 'Toggle fullscreen';
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      if (e.key === 'd' || e.key === 'D') {
        this.onToggleDashboard();
      } else if (e.key === 'm' || e.key === 'M') {
        const btn = document.getElementById('btn-metrics-overlay');
        btn?.classList.toggle('active');
        this.onToggleMetricsOverlay?.();
      }
    });
  }

  /**
   * Toggle the CPU hogger on or off.
   *
   * When active, runs a synchronous busy-loop for ~100ms every 1 second
   * on the main thread, simulating heavy JS load. Useful for testing
   * video playback smoothness under thread contention.
   */
  private toggleCpuHog(btn: HTMLElement): void {
    if (this.cpuHogInterval !== null) {
      clearInterval(this.cpuHogInterval);
      this.cpuHogInterval = null;
      btn.classList.remove('active');
      console.log('[CPU Hog] Stopped');
      return;
    }

    btn.classList.add('active');
    console.log('[CPU Hog] Started — blocking main thread ~100ms every 1s');

    this.cpuHogInterval = window.setInterval(() => {
      const start = performance.now();
      // Busy-loop until ~100ms have elapsed
      while (performance.now() - start < 100) {
        // burn CPU
      }
    }, 1000);
  }

  private static readonly UPSCALE_MODES = ['off', 'cas', 'fsr', 'a4k', 'a4k-fast', 'tsr', 'spec', 'vqsr', 'gen', 'dlss'] as const;
  private static readonly UPSCALE_DESCRIPTIONS: Record<string, string> = {
    off: 'No upscaling — raw bilinear filtering',
    cas: 'Contrast Adaptive Sharpening — sharpens soft/blurry areas while leaving edges intact. Minimal GPU cost (~1% overhead). Based on AMD FidelityFX CAS.',
    fsr: 'FidelityFX Super Resolution — detects edges via Sobel analysis then sharpens adaptively, avoiding halos. Low GPU cost (~2%). Based on AMD FSR 1.0 (EASU+RCAS).',
    a4k: 'Anime4K CNNVL Restore — 17-pass trained CNN. Enhances detail and reduces compression artifacts. Moderate GPU cost (~5-8%). May be slow on mobile devices.',
    'a4k-fast': 'Anime4K CNNM Restore — 8-pass trained CNN. Lighter version suitable for mobile. Low-moderate GPU cost (~2-4%).',
    tsr: 'Temporal Super Resolution — accumulates detail across multiple frames using motion-compensated blending. Builds sharpness over ~10 frames on static scenes. Higher GPU cost (~8-12%). Scene-cut detection auto-resets.',
    spec: 'Spectral Frequency Hallucination — DCT gap filling using 1/f natural image statistics. Synthesizes missing high-frequency bands with orientation-coherent detail from neighboring blocks. Low-moderate GPU cost (~4-6%).',
    vqsr: 'Vector-Quantized Texture Lookup — encodes 4×4 patches into 8D feature vectors, finds nearest match in 512-entry HF texture codebook, pastes high-res detail. Moderate GPU cost (~6-10%).',
    gen: 'Compact ESRGAN Generator — 4-block RRDB neural network that invents texture detail from nothing. 16-channel width, ~30K parameters baked into shader. Highest quality, highest GPU cost (~15-25%).',
    dlss: '4K Upscale (DLSS-style) — Combines temporal accumulation with spatial super-resolution and detail hallucination. Motion-compensated history blending builds sub-pixel detail over frames; edge-directed interpolation + contrast-adaptive detail synthesis enhance spatial quality; anti-ringing prevents artifacts. Mac-compatible. GPU cost (~12-18%).',
  };
}
