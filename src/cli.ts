#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { PNG } from 'pngjs';
import { vectorize, PaletteMode } from './index.js';
import { loadImage, parseHexColor } from './io.js';
import { ImageType, Quality } from './presets.js';
import { Image, toRgba8, createImage, unpremultiply, Color } from './image.js';
import { Accumulator, chainWeights, renderPolygons } from './raster.js';
import { flattenSegments } from './bezier.js';

const USAGE = `Usage: vectorize <input.png|jpg> [-o out.svg] [options]
       (interactive: vectorize-wizard <input> [output.svg])

  -t, --type <auto|logo|logo_aa|photo>   image type (default: auto)
  -q, --quality <low|medium|high>        input quality / detail level
                                         (or 0|1|2; default: medium)
  -p, --palette <auto|flexible|N|#rrggbb[aa],...>
                                         color mode (default: auto)
      --flatten <#rrggbb>                composite transparency onto this color
      --cluster-colors <on|off>          unify similar colors in flexible mode
                                         (default: on for artwork, off for photos)
      --max-side <px>                    downsample to this longer side (default: 0 =
                                         automatic, at most 1.6 megapixels)
      --stroke <px>                      seam underlap below later shapes (default: 0.35)
      --no-stack                         keep holes (shapes only abut, never overlap)
      --debug <dir>                      write intermediate images
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o' },
    type: { type: 'string', short: 't', default: 'auto' },
    quality: { type: 'string', short: 'q', default: 'medium' },
    palette: { type: 'string', short: 'p', default: 'auto' },
    'max-side': { type: 'string', default: '0' },
    stroke: { type: 'string' },
    'no-stack': { type: 'boolean' },
    flatten: { type: 'string' },
    'cluster-colors': { type: 'string' },
    debug: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || positionals.length !== 1) {
  process.stdout.write(USAGE);
  process.exit(values.help ? 0 : 1);
}

const input = positionals[0];
const img = loadImage(input);

let palette: PaletteMode = 'auto';
const pv = values.palette!;
if (pv === 'flexible' || pv === 'auto') palette = pv;
else if (/^\d+$/.test(pv)) palette = Number(pv);
else palette = pv.split(',').map(parseHexColor);
const cluster = values['cluster-colors'];
if (cluster !== undefined && cluster !== 'on' && cluster !== 'off') throw new Error('--cluster-colors must be on or off');

function parseQuality(s: string): Quality {
  const i = ['low', 'medium', 'high', '0', '1', '2'].indexOf(s.toLowerCase());
  if (i < 0) throw new Error(`bad --quality: ${s} (expected low, medium, high or 0, 1, 2)`);
  return (i % 3) as Quality;
}

const t0 = Date.now();
const result = vectorize(img, {
  type: values.type as ImageType | 'auto',
  quality: parseQuality(values.quality!),
  palette,
  maxSide: Number(values['max-side']),
  strokeWidth: values.stroke === undefined ? undefined : Number(values.stroke),
  stacked: !values['no-stack'],
  background: values.flatten === undefined ? undefined : parseHexColor(values.flatten),
  clusterColors: cluster === undefined ? undefined : cluster === 'on',
  onProgress: (s) => process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}\n`),
});

const out = values.output ?? join(process.cwd(), basename(input, extname(input)) + '.svg');
writeFileSync(out, result.svg);
const nSegs = result.curves.reduce((n, c) => n + c.length, 0);
process.stderr.write(
  `type=${result.type} quality=${result.quality} regions=${result.segmentation.count} ` +
    `chains=${result.graph.chains.length} curves=${nSegs} time=${((Date.now() - t0) / 1000).toFixed(1)}s\n` +
    (result.classification ? `classification: ${JSON.stringify(result.classification)}\n` : '') +
    `smoothing: ${JSON.stringify(result.smoothing)}\nwrote ${out}\n`,
);

if (values.debug) {
  const dir = values.debug;
  mkdirSync(dir, { recursive: true });
  const { width: w, height: h } = result.working;
  // Debug buffers are premultiplied; PNG wants straight alpha.
  const save = (name: string, img: Image) => {
    const straight = createImage(w, h);
    for (let i = 0; i < w * h; i++) straight.data.set(unpremultiply(Array.from(img.data.subarray(i * 4, i * 4 + 4)) as Color), i * 4);
    const p = new PNG({ width: w, height: h });
    p.data = Buffer.from(toRgba8(straight));
    writeFileSync(join(dir, name), PNG.sync.write(p));
  };
  save('1-working.png', result.working);
  const segImg = createImage(w, h);
  const seg = result.segmentation;
  for (let p = 0; p < w * h; p++) segImg.data.set(seg.colors[seg.labels[p]], p * 4);
  save('2-segmentation.png', segImg);
  // Polygonal render of the smoothed contours and of the flattened Bézier curves.
  const acc = new Accumulator(w, h);
  const buf = new Float64Array(w * h * 4);
  renderPolygons(result.graph, chainWeights(result.graph, seg.colors), result.graph.x, result.graph.y, acc, buf);
  save('3-smoothed.png', { width: w, height: h, data: Float32Array.from(buf) });
  process.stderr.write(`debug images in ${dir} (curves: ${result.curves.map((c) => flattenSegments(c).length).reduce((a, b) => a + b, 0)} points)\n`);
}
