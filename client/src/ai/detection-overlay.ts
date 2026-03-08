/**
 * DOM overlay for YOLO object detection bounding boxes.
 *
 * Renders colored bounding boxes with class labels over the video canvas.
 * Each detection gets a colored rectangle + label tag (e.g., "person 87%").
 * Uses absolute positioning within the stream tile wrapper.
 */

/** A single detected object */
export interface Detection {
  /** Bounding box in normalized [0,1] coordinates */
  x: number;
  y: number;
  w: number;
  h: number;
  /** COCO class index */
  classId: number;
  /** Class name (e.g., "person") */
  className: string;
  /** Confidence score (0..1) */
  confidence: number;
}

/** Color palette for COCO classes (deterministic per classId) */
const CLASS_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e', '#14b8a6',
  '#84cc16', '#a855f7', '#6366f1', '#0ea5e9', '#d946ef',
  '#f59e0b', '#10b981', '#6d28d9', '#e11d48', '#0891b2',
];

/** Get a deterministic color for a COCO class */
function classColor(classId: number): string {
  return CLASS_COLORS[classId % CLASS_COLORS.length];
}

/** A single detection box element */
interface BoxElement {
  container: HTMLDivElement;
  label: HTMLDivElement;
}

/**
 * Manages detection bounding box overlays for a single stream tile.
 */
export class DetectionOverlay {
  private readonly pool: BoxElement[] = [];
  private activeCount = 0;
  private readonly tileElement: HTMLElement;
  private fpsCounter: HTMLDivElement | null = null;
  private enabled = false;

  constructor(tileElement: HTMLElement) {
    this.tileElement = tileElement;
  }

  /** Enable the overlay and show FPS counter */
  enable(): void {
    this.enabled = true;
    if (!this.fpsCounter) {
      this.fpsCounter = document.createElement('div');
      this.fpsCounter.style.cssText =
        'position:absolute;top:4px;right:40px;background:rgba(59,130,246,0.85);' +
        'color:#fff;font-size:11px;padding:2px 8px;border-radius:4px;' +
        'pointer-events:none;z-index:10;font-family:monospace;';
      this.fpsCounter.textContent = 'AI: -- fps';
      this.tileElement.appendChild(this.fpsCounter);
    }
    this.fpsCounter.style.display = 'block';
  }

  /** Disable the overlay and hide everything */
  disable(): void {
    this.enabled = false;
    this.clearBoxes();
    if (this.fpsCounter) {
      this.fpsCounter.style.display = 'none';
    }
  }

  /** Update the AI FPS counter */
  updateFPS(fps: number): void {
    if (this.fpsCounter) {
      this.fpsCounter.textContent = `AI: ${fps} fps`;
    }
  }

  /** Display a set of detections. Reuses DOM elements from a pool. */
  setDetections(detections: Detection[]): void {
    if (!this.enabled) return;

    // Ensure we have enough pooled elements
    while (this.pool.length < detections.length) {
      const container = document.createElement('div');
      container.style.cssText =
        'position:absolute;pointer-events:none;z-index:6;' +
        'border:2px solid transparent;border-radius:2px;display:none;';

      const label = document.createElement('div');
      label.style.cssText =
        'position:absolute;top:-18px;left:-1px;color:#fff;font-size:10px;' +
        'padding:1px 6px;border-radius:2px 2px 0 0;font-family:monospace;' +
        'white-space:nowrap;';

      container.appendChild(label);
      this.tileElement.appendChild(container);
      this.pool.push({ container, label });
    }

    // Update visible boxes
    for (let i = 0; i < detections.length; i++) {
      const det = detections[i];
      const box = this.pool[i];
      const color = classColor(det.classId);

      box.container.style.display = 'block';
      box.container.style.left = `${det.x * 100}%`;
      box.container.style.top = `${det.y * 100}%`;
      box.container.style.width = `${det.w * 100}%`;
      box.container.style.height = `${det.h * 100}%`;
      box.container.style.borderColor = color;

      box.label.style.background = color;
      box.label.textContent = `${det.className} ${(det.confidence * 100).toFixed(0)}%`;
    }

    // Hide unused boxes
    for (let i = detections.length; i < this.activeCount; i++) {
      this.pool[i].container.style.display = 'none';
    }

    this.activeCount = detections.length;
  }

  /** Clear all visible boxes */
  clearBoxes(): void {
    for (let i = 0; i < this.activeCount; i++) {
      this.pool[i].container.style.display = 'none';
    }
    this.activeCount = 0;
  }

  /** Destroy all elements */
  destroy(): void {
    for (const box of this.pool) {
      box.container.remove();
    }
    this.pool.length = 0;
    this.activeCount = 0;
    this.fpsCounter?.remove();
    this.fpsCounter = null;
  }
}
