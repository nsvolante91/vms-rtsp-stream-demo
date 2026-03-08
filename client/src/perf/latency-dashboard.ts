/**
 * Latency Dashboard — per-stream latency breakdown panel.
 *
 * Shows transport → decode → queue → render latency waterfall
 * with a large headline number and sparkline history chart.
 * Updated at 1Hz from worker metrics.
 */

/** Latency breakdown for a single stream */
export interface LatencyBreakdown {
  /** Server send → client receive (ms) */
  transportMs: number;
  /** Receive → decode complete (ms) */
  decodeMs: number;
  /** Decode complete → queued for render (ms) */
  queueMs: number;
  /** Queue → rendered on screen (ms) */
  renderMs: number;
  /** Total end-to-end (ms) */
  totalMs: number;
  /** Frame jitter (ms) */
  jitterMs: number;
}

/** Per-stream latency state */
interface StreamLatencyState {
  history: number[];
  row: HTMLDivElement;
  headline: HTMLSpanElement;
  bars: HTMLDivElement;
  sparkline: HTMLCanvasElement;
  sparkCtx: CanvasRenderingContext2D;
}

/**
 * Latency dashboard panel with per-stream breakdowns and sparklines.
 */
export class LatencyDashboard {
  private readonly panel: HTMLDivElement;
  private readonly streamStates: Map<number, StreamLatencyState> = new Map();
  private readonly container: HTMLDivElement;
  private visible = false;

  /** Maximum sparkline history points */
  private static readonly MAX_HISTORY = 60;

  constructor() {
    this.panel = document.createElement('div');
    this.panel.className = 'latency-dashboard';
    this.panel.style.cssText =
      'position:fixed;left:8px;top:60px;width:320px;max-height:500px;' +
      'background:rgba(10,10,10,0.93);border:1px solid rgba(59,130,246,0.3);' +
      'border-radius:8px;overflow:hidden;z-index:100;display:none;' +
      'font-family:monospace;font-size:11px;color:#e5e7eb;';

    const header = document.createElement('div');
    header.style.cssText =
      'padding:8px 12px;background:rgba(59,130,246,0.15);color:#fff;' +
      'font-weight:bold;border-bottom:1px solid rgba(59,130,246,0.2);' +
      'display:flex;align-items:center;gap:8px;';
    header.innerHTML = '<span style="font-size:13px">Latency Dashboard</span>';
    this.panel.appendChild(header);

    this.container = document.createElement('div');
    this.container.style.cssText = 'padding:8px;overflow-y:auto;max-height:460px;';
    this.panel.appendChild(this.container);

    document.body.appendChild(this.panel);
  }

  /** Toggle visibility */
  toggle(): void {
    this.visible = !this.visible;
    this.panel.style.display = this.visible ? 'block' : 'none';
  }

  /** Show the panel */
  show(): void {
    this.visible = true;
    this.panel.style.display = 'block';
  }

  /** Update latency data for a stream */
  update(streamId: number, breakdown: LatencyBreakdown): void {
    let state = this.streamStates.get(streamId);
    if (!state) {
      state = this.createStreamRow(streamId);
      this.streamStates.set(streamId, state);
    }

    // Update headline number
    state.headline.textContent = `${breakdown.totalMs.toFixed(0)}ms`;
    state.headline.style.color = breakdown.totalMs < 50 ? '#22c55e'
      : breakdown.totalMs < 100 ? '#eab308'
      : '#ef4444';

    // Update waterfall bars
    const total = Math.max(breakdown.totalMs, 1);
    state.bars.innerHTML = '';
    const segments = [
      { label: 'Transport', ms: breakdown.transportMs, color: '#3b82f6' },
      { label: 'Decode', ms: breakdown.decodeMs, color: '#8b5cf6' },
      { label: 'Queue', ms: breakdown.queueMs, color: '#f97316' },
      { label: 'Render', ms: breakdown.renderMs, color: '#22c55e' },
    ];

    for (const seg of segments) {
      const pct = Math.max((seg.ms / total) * 100, 2);
      const bar = document.createElement('div');
      bar.style.cssText =
        `display:inline-block;height:14px;background:${seg.color};` +
        `width:${pct}%;min-width:2px;border-radius:1px;margin-right:1px;` +
        'vertical-align:middle;';
      bar.title = `${seg.label}: ${seg.ms.toFixed(1)}ms`;
      state.bars.appendChild(bar);
    }

    // Update sparkline
    state.history.push(breakdown.totalMs);
    if (state.history.length > LatencyDashboard.MAX_HISTORY) {
      state.history.shift();
    }
    this.drawSparkline(state);
  }

  /** Remove a stream from the dashboard */
  removeStream(streamId: number): void {
    const state = this.streamStates.get(streamId);
    if (state) {
      state.row.remove();
      this.streamStates.delete(streamId);
    }
  }

  /** Create a row for a new stream */
  private createStreamRow(streamId: number): StreamLatencyState {
    const row = document.createElement('div');
    row.style.cssText =
      'margin-bottom:8px;padding:6px;background:rgba(255,255,255,0.04);' +
      'border-radius:4px;';

    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;';

    const title = document.createElement('span');
    title.textContent = `Stream ${streamId}`;
    title.style.color = '#9ca3af';

    const headline = document.createElement('span');
    headline.style.cssText = 'font-size:16px;font-weight:bold;color:#22c55e;';
    headline.textContent = '--ms';

    titleRow.appendChild(title);
    titleRow.appendChild(headline);
    row.appendChild(titleRow);

    const bars = document.createElement('div');
    bars.style.cssText = 'height:14px;margin-bottom:4px;overflow:hidden;border-radius:2px;';
    row.appendChild(bars);

    // Legend
    const legend = document.createElement('div');
    legend.style.cssText = 'display:flex;gap:8px;font-size:9px;color:#6b7280;margin-bottom:4px;';
    legend.innerHTML =
      '<span><span style="color:#3b82f6">■</span> Transport</span>' +
      '<span><span style="color:#8b5cf6">■</span> Decode</span>' +
      '<span><span style="color:#f97316">■</span> Queue</span>' +
      '<span><span style="color:#22c55e">■</span> Render</span>';
    row.appendChild(legend);

    const sparkline = document.createElement('canvas');
    sparkline.width = 280;
    sparkline.height = 30;
    sparkline.style.cssText = 'width:100%;height:30px;border-radius:2px;background:rgba(0,0,0,0.3);';
    row.appendChild(sparkline);

    this.container.appendChild(row);

    const sparkCtx = sparkline.getContext('2d')!;

    return { history: [], row, headline, bars, sparkline, sparkCtx };
  }

  /** Draw sparkline chart for a stream */
  private drawSparkline(state: StreamLatencyState): void {
    const { sparkCtx: ctx, sparkline: canvas, history } = state;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (history.length < 2) return;

    const maxVal = Math.max(...history, 10);
    const step = w / (LatencyDashboard.MAX_HISTORY - 1);

    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = i * step;
      const y = h - (history[i] / maxVal) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw threshold line at 100ms
    const threshY = h - (100 / maxVal) * (h - 4) - 2;
    if (threshY > 0 && threshY < h) {
      ctx.strokeStyle = 'rgba(239,68,68,0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, threshY);
      ctx.lineTo(w, threshY);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** Destroy the panel */
  destroy(): void {
    this.panel.remove();
    this.streamStates.clear();
  }
}
