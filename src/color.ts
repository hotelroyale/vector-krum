// Hex color parsing and formatting (straight alpha). Browser-safe.
import { Color } from './image.js';

/** Parses `#rrggbb` or `#rrggbbaa` (leading # optional) into a straight-alpha color. */
export function parseHexColor(s: string): Color {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(s.trim());
  if (!m) throw new Error(`bad color: ${s} (expected #rrggbb or #rrggbbaa)`);
  const v = (h: string | undefined, d: number) => (h === undefined ? d : parseInt(h, 16) / 255);
  return [v(m[1], 0), v(m[2], 0), v(m[3], 0), v(m[4], 1)];
}

export function toHexColor(c: Color): string {
  const h = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return '#' + h(c[0]) + h(c[1]) + h(c[2]) + (c[3] < 0.999 ? h(c[3]) : '');
}
