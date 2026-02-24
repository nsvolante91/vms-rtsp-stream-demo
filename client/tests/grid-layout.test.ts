import { describe, it, expect } from 'vitest';
import { calculateGrid, calculateFocusLayout } from '../src/render/grid-layout';

describe('calculateGrid', () => {
  it('returns empty array for no streams', () => {
    expect(calculateGrid([], 2)).toEqual([]);
  });

  it('returns empty array for zero columns', () => {
    expect(calculateGrid([1], 0)).toEqual([]);
  });

  it('handles single stream in 1x1 grid', () => {
    const result = calculateGrid([1], 1);
    expect(result).toEqual([
      { streamId: 1, x: 0, y: 0, width: 1, height: 1 },
    ]);
  });

  it('lays out 4 streams in 2x2 grid', () => {
    const result = calculateGrid([1, 2, 3, 4], 2);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ streamId: 1, x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(result[1]).toEqual({ streamId: 2, x: 0.5, y: 0, width: 0.5, height: 0.5 });
    expect(result[2]).toEqual({ streamId: 3, x: 0, y: 0.5, width: 0.5, height: 0.5 });
    expect(result[3]).toEqual({ streamId: 4, x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
  });

  it('handles fewer streams than grid cells (3 streams in 2x2)', () => {
    const result = calculateGrid([1, 2, 3], 2);
    expect(result).toHaveLength(3);
    // 2 rows because ceil(3/2)=2
    expect(result[0]).toEqual({ streamId: 1, x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(result[1]).toEqual({ streamId: 2, x: 0.5, y: 0, width: 0.5, height: 0.5 });
    expect(result[2]).toEqual({ streamId: 3, x: 0, y: 0.5, width: 0.5, height: 0.5 });
  });

  it('lays out 9 streams in 3x3 grid', () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const result = calculateGrid(ids, 3);
    expect(result).toHaveLength(9);
    const w = 1 / 3;
    const h = 1 / 3;
    // Check corners
    expect(result[0].x).toBeCloseTo(0);
    expect(result[0].y).toBeCloseTo(0);
    expect(result[0].width).toBeCloseTo(w);
    expect(result[8].x).toBeCloseTo(2 * w);
    expect(result[8].y).toBeCloseTo(2 * h);
  });

  it('covers entire canvas area', () => {
    const result = calculateGrid([1, 2, 3, 4], 2);
    // Total area should be 1.0
    const totalArea = result.reduce((sum, v) => sum + v.width * v.height, 0);
    expect(totalArea).toBeCloseTo(1.0);
  });
});

describe('calculateFocusLayout', () => {
  it('returns empty array for no streams', () => {
    expect(calculateFocusLayout([], 1)).toEqual([]);
  });

  it('single stream fills entire canvas', () => {
    const result = calculateFocusLayout([1], 1);
    expect(result).toEqual([
      { streamId: 1, x: 0, y: 0, width: 1, height: 1 },
    ]);
  });

  it('focused stream gets 75% width, others in sidebar', () => {
    const result = calculateFocusLayout([1, 2, 3], 1);
    expect(result).toHaveLength(3);

    // Focus stream
    const focus = result.find(v => v.streamId === 1)!;
    expect(focus.x).toBe(0);
    expect(focus.y).toBe(0);
    expect(focus.width).toBe(0.75);
    expect(focus.height).toBe(1);

    // Sidebar streams
    const sidebar = result.filter(v => v.streamId !== 1);
    expect(sidebar).toHaveLength(2);
    for (const v of sidebar) {
      expect(v.x).toBe(0.75);
      expect(v.width).toBe(0.25);
    }
    expect(sidebar[0].height).toBe(0.5);
    expect(sidebar[1].height).toBe(0.5);
    expect(sidebar[0].y).toBe(0);
    expect(sidebar[1].y).toBe(0.5);
  });

  it('two streams: focus + one sidebar', () => {
    const result = calculateFocusLayout([1, 2], 1);
    expect(result).toHaveLength(2);

    const focus = result.find(v => v.streamId === 1)!;
    expect(focus.width).toBe(0.75);

    const side = result.find(v => v.streamId === 2)!;
    expect(side.x).toBe(0.75);
    expect(side.width).toBe(0.25);
    expect(side.height).toBe(1);
  });
});
