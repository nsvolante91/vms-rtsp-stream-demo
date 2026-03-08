/**
 * Alert Manager — manages alert zones and motion detection state.
 *
 * Tracks per-stream alert zones, maintains alert history with timestamps,
 * and manages threshold-based alerting from GPU motion detection results.
 */

/** A rectangular alert zone in normalized [0,1] UV coordinates */
export interface AlertZone {
  /** Unique zone identifier */
  id: number;
  /** Stream this zone belongs to */
  streamId: number;
  /** Top-left U coordinate (0..1) */
  x: number;
  /** Top-left V coordinate (0..1) */
  y: number;
  /** Width in UV space (0..1) */
  w: number;
  /** Height in UV space (0..1) */
  h: number;
  /** Motion score threshold (0..1) to trigger alert */
  threshold: number;
  /** Human-readable label for this zone */
  label: string;
}

/** A triggered alert event */
export interface AlertEvent {
  /** Zone that triggered */
  zone: AlertZone;
  /** Motion score (0..1) — fraction of zone pixels with motion */
  score: number;
  /** Timestamp when alert triggered */
  timestamp: number;
}

/** Callback for alert state changes */
export type AlertCallback = (streamId: number, zoneId: number, active: boolean, score: number) => void;

/**
 * Manages alert zones across all streams and processes motion detection results.
 */
export class AlertManager {
  private readonly zones: Map<number, AlertZone> = new Map();
  private readonly alertHistory: AlertEvent[] = [];
  private readonly activeAlerts: Set<number> = new Set();
  private nextZoneId = 1;
  private alertCallback: AlertCallback | null = null;

  /** Maximum alert history entries to retain */
  private static readonly MAX_HISTORY = 200;

  /** Register a callback for alert state changes */
  onAlert(callback: AlertCallback): void {
    this.alertCallback = callback;
  }

  /**
   * Add a new alert zone for a stream.
   *
   * @param streamId - Stream to add the zone to
   * @param x - Top-left U coordinate (0..1)
   * @param y - Top-left V coordinate (0..1)
   * @param w - Width in UV space (0..1)
   * @param h - Height in UV space (0..1)
   * @param threshold - Motion score threshold (default 0.05 = 5% of zone pixels)
   * @param label - Optional label for the zone
   * @returns The created zone
   */
  addZone(
    streamId: number,
    x: number,
    y: number,
    w: number,
    h: number,
    threshold = 0.05,
    label?: string,
  ): AlertZone {
    const id = this.nextZoneId++;
    const zone: AlertZone = {
      id,
      streamId,
      x,
      y,
      w,
      h,
      threshold,
      label: label ?? `Zone ${id}`,
    };
    this.zones.set(id, zone);
    return zone;
  }

  /** Remove a zone by ID */
  removeZone(zoneId: number): void {
    this.zones.delete(zoneId);
    this.activeAlerts.delete(zoneId);
  }

  /** Get all zones for a specific stream */
  getZonesForStream(streamId: number): AlertZone[] {
    return Array.from(this.zones.values()).filter(z => z.streamId === streamId);
  }

  /** Get all zones */
  getAllZones(): AlertZone[] {
    return Array.from(this.zones.values());
  }

  /** Get alert history (most recent first) */
  getHistory(): readonly AlertEvent[] {
    return this.alertHistory;
  }

  /** Whether a zone is currently in alert state */
  isActive(zoneId: number): boolean {
    return this.activeAlerts.has(zoneId);
  }

  /**
   * Process motion detection results from the GPU.
   *
   * @param streamId - Stream the results belong to
   * @param zoneScores - Array of motion scores per zone (fraction of pixels with motion)
   */
  processMotionResults(streamId: number, zoneScores: Map<number, number>): void {
    const zones = this.getZonesForStream(streamId);

    for (const zone of zones) {
      const score = zoneScores.get(zone.id) ?? 0;
      const wasActive = this.activeAlerts.has(zone.id);
      const isActive = score >= zone.threshold;

      if (isActive && !wasActive) {
        // Alert triggered
        this.activeAlerts.add(zone.id);
        this.alertHistory.unshift({
          zone,
          score,
          timestamp: performance.now(),
        });

        // Trim history
        if (this.alertHistory.length > AlertManager.MAX_HISTORY) {
          this.alertHistory.length = AlertManager.MAX_HISTORY;
        }

        this.alertCallback?.(streamId, zone.id, true, score);
      } else if (!isActive && wasActive) {
        // Alert cleared
        this.activeAlerts.delete(zone.id);
        this.alertCallback?.(streamId, zone.id, false, score);
      }
    }
  }

  /** Clear all zones and history */
  clear(): void {
    this.zones.clear();
    this.alertHistory.length = 0;
    this.activeAlerts.clear();
    this.nextZoneId = 1;
  }

  /** Remove all zones for a specific stream */
  clearStream(streamId: number): void {
    for (const [id, zone] of this.zones) {
      if (zone.streamId === streamId) {
        this.zones.delete(id);
        this.activeAlerts.delete(id);
      }
    }
  }
}
