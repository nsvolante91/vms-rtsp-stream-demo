/**
 * UI control handlers for the VMS application.
 *
 * Binds event handlers to the HTML control bar buttons for layout
 * switching, stream management, benchmarking, metrics export,
 * and dashboard toggling.
 */

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
    private readonly onToggleDashboard: () => void
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

    // Keyboard shortcut: 'D' toggles dashboard
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'd' || e.key === 'D') {
        // Ignore if user is typing in an input element
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
          return;
        }
        this.onToggleDashboard();
      }
    });
  }
}
