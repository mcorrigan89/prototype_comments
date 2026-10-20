import { beforeEach, describe, expect, it } from 'vitest';
import { loadToolbarPosition, nearestPosition, saveToolbarPosition, stepPosition } from '../src/ui/toolbar-position';

const viewport = { w: 1200, h: 800 };

describe('toolbar position', () => {
  beforeEach(() => localStorage.clear());

  it('snaps a drop to the nearest of six spots', () => {
    expect(nearestPosition({ x: 100, y: 50 }, viewport)).toBe('top-left');
    expect(nearestPosition({ x: 600, y: 50 }, viewport)).toBe('top-center');
    expect(nearestPosition({ x: 1100, y: 700 }, viewport)).toBe('bottom-right');
    expect(nearestPosition({ x: 500, y: 790 }, viewport)).toBe('bottom-center');
  });

  it('moves between spots with arrow keys, stopping at the edges', () => {
    expect(stepPosition('bottom-center', 'ArrowUp')).toBe('top-center');
    expect(stepPosition('bottom-center', 'ArrowRight')).toBe('bottom-right');
    expect(stepPosition('bottom-right', 'ArrowRight')).toBe('bottom-right');
    expect(stepPosition('top-left', 'ArrowDown')).toBe('bottom-left');
    expect(stepPosition('top-left', 'Enter')).toBe('top-left');
  });

  it('remembers the choice and ignores junk', () => {
    expect(loadToolbarPosition()).toBeNull();
    saveToolbarPosition('top-right');
    expect(loadToolbarPosition()).toBe('top-right');
    localStorage.setItem('pc:v1:toolbar-position', 'middle-ish');
    expect(loadToolbarPosition()).toBeNull();
  });
});
