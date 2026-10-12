// Suggested palettes for the wizard's palette step (terminal and web UI). Browser-safe.
import { workingImage } from './index.js';
import { Image, Color, unpremultiply, flattenAlpha } from './image.js';
import { ImageType, Quality, getPreset } from './presets.js';
import { scanPalettes } from './palette.js';

/** How transparent areas are handled: kept, or composited onto a color first. */
export type Transparency = 'keep' | Color;

export interface SuggestedPalette {
  /** Straight-alpha colors. */
  colors: Color[];
  /** Lower is better; the lowest score is the palette automatic mode picks. */
  score: number;
}

/**
 * Candidate palettes for K = 2..24, computed exactly as automatic mode does (same working image),
 * so the best-scoring one is the palette automatic mode would pick.
 */
export function suggestPalettes(image: Image, type: ImageType, quality: Quality, transparency: Transparency, maxSide = 0): SuggestedPalette[] {
  const preset = getPreset(type, quality);
  const flat = transparency === 'keep' ? image : flattenAlpha(image, transparency);
  const palettes = scanPalettes(workingImage(flat, preset, maxSide), preset.palette);
  if (palettes.length > 0 && palettes[palettes.length - 1].colors.length < palettes.length + 1) palettes.pop(); // duplicate of a smaller K
  return palettes.map((p) => ({ colors: p.colors.map(unpremultiply), score: p.score }));
}
