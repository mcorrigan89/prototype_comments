import type { Pin } from './types';
import { clamp, round4 } from './util';

const MAX_TEXT = 80;
const MAX_TEXT_SCAN = 3000;

export function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function isUnique(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

// Ids that look generated (React useId, numeric suffixes) change between builds.
const UNSTABLE_ID = /^\d|:|\d{3,}/;

/**
 * Builds a selector for an element, preferring stable hooks:
 * data-pc-anchor > data-testid > unique id > nth-of-type path from the nearest stable ancestor.
 */
export function buildSelector(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    const anchor = node.getAttribute('data-pc-anchor');
    if (anchor) {
      parts.unshift(`[data-pc-anchor="${CSS.escape(anchor)}"]`);
      break;
    }
    const testId = node.getAttribute('data-testid');
    if (testId && isUnique(`[data-testid="${CSS.escape(testId)}"]`)) {
      parts.unshift(`[data-testid="${CSS.escape(testId)}"]`);
      break;
    }
    if (node.id && !UNSTABLE_ID.test(node.id) && isUnique(`#${CSS.escape(node.id)}`)) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    if (node === document.body) {
      parts.unshift('body');
      break;
    }
    const tag = node.tagName.toLowerCase();
    let index = 1;
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.tagName === node.tagName) index++;
    }
    parts.unshift(`${tag}:nth-of-type(${index})`);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

export function makePin(el: Element, clientX: number, clientY: number): Pin {
  const target = el === document.documentElement ? document.body : el;
  const rect = target.getBoundingClientRect();
  const ox = rect.width ? (clientX - rect.left) / rect.width : 0.5;
  const oy = rect.height ? (clientY - rect.top) / rect.height : 0.5;
  return {
    selector: buildSelector(target),
    tag: target.tagName.toLowerCase(),
    text: textOf(target),
    offset: { x: round4(clamp(ox, 0, 1)), y: round4(clamp(oy, 0, 1)) },
    page: { x: Math.round(clientX + window.scrollX), y: Math.round(clientY + window.scrollY) },
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}

/** Finds the single element of a tag with exactly this text; null if none or ambiguous. */
function findByText(tag: string, text: string): Element | null {
  const candidates = document.getElementsByTagName(tag);
  let match: Element | null = null;
  for (let i = 0; i < candidates.length && i < MAX_TEXT_SCAN; i++) {
    if (textOf(candidates[i]) === text) {
      if (match) return null;
      match = candidates[i];
    }
  }
  return match;
}

/** Re-finds the element a pin was dropped on, tolerating small changes to the page. */
export function resolveElement(pin: Pin): Element | null {
  let el: Element | null = null;
  try {
    el = pin.selector ? document.querySelector(pin.selector) : null;
  } catch {
    el = null;
  }
  if (!pin.text) return el;
  if (!el || textOf(el) !== pin.text) {
    // The selector broke or now points somewhere else — try matching on text instead.
    return findByText(pin.tag, pin.text) ?? el;
  }
  return el;
}

export interface Point {
  x: number;
  y: number;
  /** false when we fell back to the original page coordinates. */
  anchored: boolean;
}

/** Viewport position for a pin, or null if its element exists but isn't visible. */
export function pointFor(pin: Pin, el: Element | null): Point | null {
  if (el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
      return null;
    }
    return { x: rect.left + pin.offset.x * rect.width, y: rect.top + pin.offset.y * rect.height, anchored: true };
  }
  return { x: pin.page.x - window.scrollX, y: pin.page.y - window.scrollY, anchored: false };
}
