/**
 * YOLO output postprocessing — NMS + output parsing.
 *
 * Parses raw ONNX Runtime output tensor from YOLOv8 into
 * bounding box detections with class labels and confidence scores.
 * Applies Non-Maximum Suppression to filter overlapping boxes.
 */

import type { Detection } from './detection-overlay';

/** COCO 80-class labels */
export const COCO_CLASSES: string[] = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck',
  'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench',
  'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra',
  'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove',
  'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup',
  'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
  'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear',
  'hair drier', 'toothbrush',
];

/** YOLO input image size (square) */
export const YOLO_INPUT_SIZE = 640;

/** Raw YOLOv8 output shape: [1, 84, 8400] (transposed to [8400, 84]) */
export interface YOLOOutput {
  /** Float32 data in shape [1, 84, 8400] */
  data: Float32Array;
  /** Number of detections (columns = 8400) */
  numDetections: number;
  /** Number of outputs per detection (rows = 84: 4 bbox + 80 classes) */
  numOutputs: number;
}

/**
 * Compute Intersection over Union between two boxes.
 */
function iou(a: Detection, b: Detection): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const aArea = a.w * a.h;
  const bArea = b.w * b.h;

  return intersection / (aArea + bArea - intersection + 1e-6);
}

/**
 * Non-Maximum Suppression — filter overlapping detections.
 *
 * @param detections - Array of detections sorted by confidence (desc)
 * @param iouThreshold - IoU threshold for suppression (default 0.45)
 * @returns Filtered detections
 */
export function nms(detections: Detection[], iouThreshold = 0.45): Detection[] {
  const result: Detection[] = [];
  const suppressed = new Set<number>();

  for (let i = 0; i < detections.length; i++) {
    if (suppressed.has(i)) continue;
    result.push(detections[i]);

    for (let j = i + 1; j < detections.length; j++) {
      if (suppressed.has(j)) continue;
      if (detections[i].classId === detections[j].classId &&
          iou(detections[i], detections[j]) > iouThreshold) {
        suppressed.add(j);
      }
    }
  }

  return result;
}

/**
 * Parse YOLOv8 output tensor into detections.
 *
 * YOLOv8 output shape is [1, 84, 8400]:
 * - 84 = 4 bbox (cx, cy, w, h in pixels) + 80 class scores
 * - 8400 = number of anchor predictions
 *
 * Coordinates are in YOLO input space (640×640). This function
 * normalizes them to [0,1] and applies the original aspect ratio
 * letterbox transformation.
 *
 * @param output - Raw ONNX output
 * @param confThreshold - Minimum confidence to keep (default 0.25)
 * @param imgWidth - Original image width (for letterbox correction)
 * @param imgHeight - Original image height (for letterbox correction)
 * @returns Array of detections after NMS
 */
export function parseYOLOv8Output(
  output: YOLOOutput,
  confThreshold = 0.25,
  imgWidth = YOLO_INPUT_SIZE,
  imgHeight = YOLO_INPUT_SIZE,
): Detection[] {
  const { data, numDetections, numOutputs } = output;
  const numClasses = numOutputs - 4;
  const detections: Detection[] = [];

  // Compute letterbox parameters (same as preprocessing)
  const scale = Math.min(YOLO_INPUT_SIZE / imgWidth, YOLO_INPUT_SIZE / imgHeight);
  const newW = imgWidth * scale;
  const newH = imgHeight * scale;
  const padX = (YOLO_INPUT_SIZE - newW) / 2;
  const padY = (YOLO_INPUT_SIZE - newH) / 2;

  // Data is in [1, 84, 8400] layout = row-major with 84 rows, 8400 cols
  // data[row * 8400 + col] gives row's value for detection col
  for (let i = 0; i < numDetections; i++) {
    // Find best class
    let maxScore = 0;
    let maxClassId = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = data[(4 + c) * numDetections + i];
      if (score > maxScore) {
        maxScore = score;
        maxClassId = c;
      }
    }

    if (maxScore < confThreshold) continue;

    // Extract bbox (cx, cy, w, h) in YOLO input space
    const cx = data[0 * numDetections + i];
    const cy = data[1 * numDetections + i];
    const bw = data[2 * numDetections + i];
    const bh = data[3 * numDetections + i];

    // Convert from YOLO input space to original image space
    // Undo letterbox padding and scaling
    const x1 = (cx - bw / 2 - padX) / newW;
    const y1 = (cy - bh / 2 - padY) / newH;
    const w = bw / newW;
    const h = bh / newH;

    // Skip out-of-bounds detections
    if (x1 + w < 0 || y1 + h < 0 || x1 > 1 || y1 > 1) continue;

    detections.push({
      x: Math.max(0, x1),
      y: Math.max(0, y1),
      w: Math.min(w, 1 - Math.max(0, x1)),
      h: Math.min(h, 1 - Math.max(0, y1)),
      classId: maxClassId,
      className: COCO_CLASSES[maxClassId] ?? `class_${maxClassId}`,
      confidence: maxScore,
    });
  }

  // Sort by confidence (descending) and apply NMS
  detections.sort((a, b) => b.confidence - a.confidence);
  return nms(detections);
}
