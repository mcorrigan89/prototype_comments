import { LOG } from '../util';

/** Where the toolbar sits: one of six spots along the top and bottom edges. */
export type ToolbarPosition = `${'top' | 'bottom'}-${'left' | 'center' | 'right'}`;

export const TOOLBAR_POSITIONS: ToolbarPosition[] = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];
export const DEFAULT_TOOLBAR_POSITION: ToolbarPosition = 'bottom-center';

const STORAGE_KEY = 'pc:v1:toolbar-position';

export function isToolbarPosition(value: unknown): value is ToolbarPosition {
  return TOOLBAR_POSITIONS.includes(value as ToolbarPosition);
}

/** The spot closest to where the toolbar was dropped, judged by its center point. */
export function nearestPosition(center: { x: number; y: number }, viewport: { w: number; h: number }): ToolbarPosition {
  const vertical = center.y < viewport.h / 2 ? 'top' : 'bottom';
  const horizontal = center.x < viewport.w / 3 ? 'left' : center.x > (viewport.w * 2) / 3 ? 'right' : 'center';
  return `${vertical}-${horizontal}`;
}

/** Arrow keys on the drag handle move between spots. */
export function stepPosition(from: ToolbarPosition, key: string): ToolbarPosition {
  const [v, hz] = from.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right'];
  const columns = ['left', 'center', 'right'] as const;
  const i = columns.indexOf(hz);
  if (key === 'ArrowUp') return `top-${hz}`;
  if (key === 'ArrowDown') return `bottom-${hz}`;
  if (key === 'ArrowLeft') return `${v}-${columns[Math.max(0, i - 1)]}`;
  if (key === 'ArrowRight') return `${v}-${columns[Math.min(2, i + 1)]}`;
  return from;
}

/** Each reviewer's own choice, kept in their browser. */
export function loadToolbarPosition(): ToolbarPosition | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isToolbarPosition(saved) ? saved : null;
  } catch {
    return null;
  }
}

export function saveToolbarPosition(position: ToolbarPosition) {
  try {
    localStorage.setItem(STORAGE_KEY, position);
  } catch (err) {
    console.warn(LOG, 'couldn’t remember the toolbar position', err);
  }
}

/**
 * Lets `el` be dragged by `handle`. While dragging the toolbar follows the
 * pointer freely; on release `onDrop` gets the nearest spot to snap to.
 */
export function makeDraggable(el: HTMLElement, handle: HTMLElement, onDrop: (position: ToolbarPosition) => void) {
  let start: { x: number; y: number; left: number; top: number } | null = null;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
    handle.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    // Free positioning while dragging; inline styles override the snapped spot.
    Object.assign(el.style, { left: `${rect.left}px`, top: `${rect.top}px`, right: 'auto', bottom: 'auto', transform: 'none' });
  });

  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(Math.max(start.left + e.clientX - start.x, 0), window.innerWidth - rect.width);
    const top = Math.min(Math.max(start.top + e.clientY - start.y, 0), window.innerHeight - rect.height);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });

  const finish = () => {
    if (!start) return;
    start = null;
    const rect = el.getBoundingClientRect();
    el.classList.remove('dragging');
    el.style.removeProperty('left');
    el.style.removeProperty('top');
    el.style.removeProperty('right');
    el.style.removeProperty('bottom');
    el.style.removeProperty('transform');
    onDrop(nearestPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, { w: window.innerWidth, h: window.innerHeight }));
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}
