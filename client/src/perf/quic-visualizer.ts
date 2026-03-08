/**
 * QUIC Stream Multiplexing Diagram — visual representation of
 * independent per-feed QUIC streams showing no HOL blocking.
 *
 * Displays a schematic diagram with one row per subscribed stream,
 * showing data flow pulses and independent stream state.
 */

/** Per-stream activity state for visualization */
interface StreamVizState {
  streamId: number;
  row: HTMLDivElement;
  indicator: HTMLDivElement;
  label: HTMLSpanElement;
  bytesLabel: HTMLSpanElement;
  lastActivityMs: number;
}

/**
 * QUIC stream multiplexing visualizer.
 */
export class QUICVisualizer {
  private readonly panel: HTMLDivElement;
  private readonly streamRows: Map<number, StreamVizState> = new Map();
  private readonly container: HTMLDivElement;
  private visible = false;

  constructor() {
    this.panel = document.createElement('div');
    this.panel.className = 'quic-visualizer';
    this.panel.style.cssText =
      'position:fixed;left:8px;bottom:60px;width:280px;' +
      'background:rgba(10,10,10,0.93);border:1px solid rgba(34,197,94,0.3);' +
      'border-radius:8px;overflow:hidden;z-index:100;display:none;' +
      'font-family:monospace;font-size:11px;color:#e5e7eb;';

    const header = document.createElement('div');
    header.style.cssText =
      'padding:8px 12px;background:rgba(34,197,94,0.12);color:#fff;' +
      'font-weight:bold;border-bottom:1px solid rgba(34,197,94,0.2);';
    header.textContent = 'QUIC Streams (No HOL Blocking)';
    this.panel.appendChild(header);

    // Diagram header
    const diagramHeader = document.createElement('div');
    diagramHeader.style.cssText =
      'padding:4px 12px;display:flex;gap:8px;color:#6b7280;font-size:9px;';
    diagramHeader.innerHTML =
      '<span style="flex:0 0 60px">Stream</span>' +
      '<span style="flex:1">Flow</span>' +
      '<span style="flex:0 0 60px;text-align:right">Rate</span>';
    this.panel.appendChild(diagramHeader);

    this.container = document.createElement('div');
    this.container.style.cssText = 'padding:4px 8px 8px;';
    this.panel.appendChild(this.container);

    // Footer explanation
    const footer = document.createElement('div');
    footer.style.cssText =
      'padding:4px 12px 8px;color:#4b5563;font-size:9px;' +
      'border-top:1px solid rgba(255,255,255,0.05);margin-top:4px;';
    footer.textContent = 'Each feed has independent QUIC flow control — ' +
      'one slow stream cannot block others.';
    this.panel.appendChild(footer);

    document.body.appendChild(this.panel);
  }

  /** Toggle visibility */
  toggle(): void {
    this.visible = !this.visible;
    this.panel.style.display = this.visible ? 'block' : 'none';
  }

  /** Update stream activity */
  updateStream(streamId: number, bitrateKbps: number): void {
    let state = this.streamRows.get(streamId);
    if (!state) {
      state = this.createStreamRow(streamId);
      this.streamRows.set(streamId, state);
    }

    state.lastActivityMs = performance.now();

    // Update bitrate label
    if (bitrateKbps >= 1000) {
      state.bytesLabel.textContent = `${(bitrateKbps / 1000).toFixed(1)} Mbps`;
    } else {
      state.bytesLabel.textContent = `${bitrateKbps.toFixed(0)} kbps`;
    }

    // Pulse the activity indicator
    state.indicator.style.background = '#22c55e';
    state.indicator.style.boxShadow = '0 0 6px rgba(34,197,94,0.6)';
    setTimeout(() => {
      state!.indicator.style.background = 'rgba(34,197,94,0.3)';
      state!.indicator.style.boxShadow = 'none';
    }, 200);
  }

  /** Remove a stream */
  removeStream(streamId: number): void {
    const state = this.streamRows.get(streamId);
    if (state) {
      state.row.remove();
      this.streamRows.delete(streamId);
    }
  }

  /** Create a visualization row for a stream */
  private createStreamRow(streamId: number): StreamVizState {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:4px;' +
      'border-bottom:1px solid rgba(255,255,255,0.03);';

    const label = document.createElement('span');
    label.style.cssText = 'flex:0 0 60px;color:#9ca3af;';
    label.textContent = `Feed ${streamId}`;
    row.appendChild(label);

    // Flow indicator (represents the QUIC stream)
    const flowContainer = document.createElement('div');
    flowContainer.style.cssText =
      'flex:1;height:8px;background:rgba(34,197,94,0.08);border-radius:4px;' +
      'position:relative;overflow:hidden;';

    const indicator = document.createElement('div');
    indicator.style.cssText =
      'position:absolute;left:0;top:0;bottom:0;width:100%;' +
      'background:rgba(34,197,94,0.3);border-radius:4px;' +
      'transition:background 0.15s,box-shadow 0.15s;';
    flowContainer.appendChild(indicator);
    row.appendChild(flowContainer);

    const bytesLabel = document.createElement('span');
    bytesLabel.style.cssText = 'flex:0 0 60px;text-align:right;color:#6b7280;font-size:10px;';
    bytesLabel.textContent = '-- kbps';
    row.appendChild(bytesLabel);

    this.container.appendChild(row);

    return {
      streamId,
      row,
      indicator,
      label,
      bytesLabel,
      lastActivityMs: 0,
    };
  }

  /** Destroy the panel */
  destroy(): void {
    this.panel.remove();
    this.streamRows.clear();
  }
}
