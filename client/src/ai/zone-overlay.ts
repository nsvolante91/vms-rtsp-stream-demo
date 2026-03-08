/**
 * DOM overlay for alert zones drawn on video tiles.
 *
 * Renders colored rectangles over the video canvas showing zone boundaries.
 * Green = monitoring, Red = triggered (with pulsing border + badge).
 * Uses absolute positioning within the stream tile wrapper.
 */

import type { AlertZone } from './alert-manager';

/** A single zone overlay element */
interface ZoneElement {
  zoneId: number;
  container: HTMLDivElement;
  badge: HTMLDivElement;
  label: HTMLSpanElement;
}

/**
 * Manages zone overlays for a single stream tile.
 */
export class ZoneOverlay {
  private readonly zones: Map<number, ZoneElement> = new Map();
  private readonly tileElement: HTMLElement;

  constructor(tileElement: HTMLElement) {
    this.tileElement = tileElement;
  }

  /** Add or update a zone overlay */
  setZone(zone: AlertZone): void {
    let el = this.zones.get(zone.id);

    if (!el) {
      const container = document.createElement('div');
      container.className = 'alert-zone';
      container.style.cssText =
        'position:absolute;pointer-events:none;z-index:5;' +
        'border:2px solid rgba(34,197,94,0.8);border-radius:2px;' +
        'transition:border-color 0.2s, box-shadow 0.2s;';

      const badge = document.createElement('div');
      badge.style.cssText =
        'position:absolute;top:-1px;left:-1px;background:rgba(34,197,94,0.9);' +
        'color:#fff;font-size:10px;padding:1px 6px;border-radius:0 0 4px 0;' +
        'font-family:monospace;white-space:nowrap;display:none;';

      const label = document.createElement('span');
      label.style.cssText =
        'position:absolute;bottom:2px;left:4px;color:rgba(255,255,255,0.8);' +
        'font-size:9px;font-family:monospace;text-shadow:0 1px 2px rgba(0,0,0,0.8);';
      label.textContent = zone.label;

      container.appendChild(badge);
      container.appendChild(label);
      this.tileElement.appendChild(container);

      el = { zoneId: zone.id, container, badge, label };
      this.zones.set(zone.id, el);
    }

    // Position zone using percentage of tile dimensions
    el.container.style.left = `${zone.x * 100}%`;
    el.container.style.top = `${zone.y * 100}%`;
    el.container.style.width = `${zone.w * 100}%`;
    el.container.style.height = `${zone.h * 100}%`;
    el.label.textContent = zone.label;
  }

  /** Set alert state for a zone */
  setAlert(zoneId: number, active: boolean, score?: number): void {
    const el = this.zones.get(zoneId);
    if (!el) return;

    if (active) {
      el.container.style.borderColor = 'rgba(239,68,68,0.9)';
      el.container.style.boxShadow = '0 0 12px rgba(239,68,68,0.5), inset 0 0 8px rgba(239,68,68,0.15)';
      el.badge.style.display = 'block';
      el.badge.style.background = 'rgba(239,68,68,0.95)';
      el.badge.textContent = `MOTION${score !== undefined ? ` ${(score * 100).toFixed(0)}%` : ''}`;
    } else {
      el.container.style.borderColor = 'rgba(34,197,94,0.8)';
      el.container.style.boxShadow = 'none';
      el.badge.style.display = 'none';
    }
  }

  /** Remove a zone overlay */
  removeZone(zoneId: number): void {
    const el = this.zones.get(zoneId);
    if (el) {
      el.container.remove();
      this.zones.delete(zoneId);
    }
  }

  /** Remove all zone overlays */
  clear(): void {
    for (const el of this.zones.values()) {
      el.container.remove();
    }
    this.zones.clear();
  }

  /** Destroy all overlays */
  destroy(): void {
    this.clear();
  }
}

/**
 * Alert log panel that shows timestamped alert events.
 */
export class AlertLog {
  private readonly element: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private visible = false;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'alert-log';
    this.element.style.cssText =
      'position:fixed;right:8px;top:60px;width:280px;max-height:400px;' +
      'background:rgba(10,10,10,0.92);border:1px solid rgba(239,68,68,0.3);' +
      'border-radius:8px;overflow:hidden;z-index:100;display:none;' +
      'font-family:monospace;font-size:11px;';

    const header = document.createElement('div');
    header.style.cssText =
      'padding:8px 12px;background:rgba(239,68,68,0.15);color:#fff;' +
      'font-weight:bold;border-bottom:1px solid rgba(239,68,68,0.2);';
    header.textContent = 'Motion Alerts';
    this.element.appendChild(header);

    this.list = document.createElement('div');
    this.list.style.cssText = 'max-height:360px;overflow-y:auto;padding:4px 0;';
    this.element.appendChild(this.list);

    document.body.appendChild(this.element);
  }

  /** Add an alert entry to the log */
  addEntry(zoneName: string, streamId: number, score: number): void {
    const entry = document.createElement('div');
    entry.style.cssText =
      'padding:4px 12px;color:#fca5a5;border-bottom:1px solid rgba(255,255,255,0.05);';
    const time = new Date().toLocaleTimeString();
    entry.textContent = `${time} | Stream ${streamId} | ${zoneName} (${(score * 100).toFixed(0)}%)`;
    this.list.insertBefore(entry, this.list.firstChild);

    // Cap at 100 entries
    while (this.list.children.length > 100) {
      this.list.removeChild(this.list.lastChild!);
    }
  }

  /** Toggle visibility */
  toggle(): void {
    this.visible = !this.visible;
    this.element.style.display = this.visible ? 'block' : 'none';
  }

  /** Show the log */
  show(): void {
    this.visible = true;
    this.element.style.display = 'block';
  }

  /** Hide the log */
  hide(): void {
    this.visible = false;
    this.element.style.display = 'none';
  }

  /** Destroy the log element */
  destroy(): void {
    this.element.remove();
  }
}
