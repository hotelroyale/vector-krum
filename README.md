# Vector Krum
## A free vectorizer

A bitmap-to-vector tracer in TypeScript. PNG or JPEG in, SVG out. Runs as a CLI, an interactive terminal wizard, or a web UI.

<div align = center>

[<kbd> <br> Test the vectorizer in your Browser now 🚀 <br> </kbd>][Link]

<br>

<img width="600" alt="screen1" src="https://github.com/user-attachments/assets/3c80bf71-4bae-4843-a38f-c6361edf7741" />
<br>
<img width="600" alt="screen2" src="https://github.com/user-attachments/assets/dcb54d98-5183-4bde-97ff-e701c931194c" />
<br>
<img width="600" alt="screen3" src="https://github.com/user-attachments/assets/40931e08-2cfc-4405-859a-52103fc1e964" />
<br>
<br>
</div>

### Setup

```sh
npm install
npx tsx src/cli.ts input.png -o out.svg          # or: npm run build && node dist/cli.js …
npx tsx src/cli.ts input.png -t logo_aa -q 2 -p 4 --debug debug/
npm test
```

### Interactive wizard

```sh
npm run wizard -- input.png [output.svg]      # Node, via tsx
bun src/wizard-cli.ts input.jpg               # Bun runs the TypeScript directly
node dist/wizard-cli.js input.png out.svg     # after npm run build (bin: vectorize-wizard)
```

The wizard asks, in order:
1. **Image type:** the detected type is preselected.
2. **Input quality** (or level of detail, for photos).
3. **Transparency:** keep it, or fill it with a color. Only asked when the image has alpha.
4. **Colors:** automatic, a suggested palette (shown as color swatches with the best fit marked), a custom palette, or unlimited.
5. **Advanced settings** (optional).
6. **Output file:** defaults to `<input>.svg` next to the input. It asks before overwriting an existing file.

After a summary, it vectorizes and prints the equivalent `vectorize` command, which reproduces the
same SVG byte for byte. Then you can change the **detail level**
(High / Medium / Low) and it re-vectorizes right away, or re-run the wizard with the previous answers as defaults.

The detail level is not a separate setting: it sets the image quality and re-vectorizes, which
re-selects the quality preset, including all advanced values derived from it (`--quality`).

Input can be PNG or JPEG (detected from the file content). The wizard needs an interactive terminal;
for scripts, use `vectorize`.

### Web UI

```sh
npm run ui            # dev server (Vite), open the printed URL
npm run ui:build      # static site in ui/dist/ (relative paths, can be served from any folder)
npm run ui:typecheck
```

A single-page app (Vue 3, Vite, SCSS) in `ui/`. It follows the same steps as the wizard: image type,
input quality, transparency (only for images with alpha), color mode (two, custom or unlimited),
palette selection (suggested palettes, a custom palette editor, and click-in-image color picking), and
the result page. There you can change the detail level and colors, hand-pick advanced settings, and
download the SVG. The viewer shows the bitmap, the vector, or both in a split view with a draggable
divider. It also has a paths overlay (outlines and curve nodes), zoom, and pan. Keys: `B` / `V` / `S`
switch the view, `P` toggles paths, and `0`, `1`, `+` and `-` control zoom. Drop an image anywhere to start over;
any format the browser can decode works (PNG, JPEG, GIF, WebP, BMP, …).

Everything runs locally. The library runs in a Web Worker (`ui/src/worker.ts`) through
`src/browser.ts`, the browser entry point: RGBA input, no Node modules. Starting a new job cancels
the running one.

### Command-line options

Options: `--type auto|logo|logo_aa|photo`, `--quality low|medium|high` (or `0|1|2`), `--palette auto|flexible|N|#rrggbb,…`,
`--flatten #rrggbb`, `--cluster-colors on|off`, `--max-side`, `--stroke`, `--no-stack`, `--debug <dir>` (working image, segmentation, smoothed polygons).
Library entry point: `vectorize(image, options)` in `src/index.ts`.

## Pipeline

| Stage | Module | What it does |
|---|---|---|
| Classify | `classify.ts` | picks `logo` / `logo_aa` / `photo` (heuristic: dominant colors and blended edge pixels) |
| Presets | `presets.ts` | 9 presets (type × quality) |
| Preprocess | `image.ts` | premultiply alpha, shrink inputs above 1.6 MP by an integer box factor `ceil(sqrt(w·h/1.6M))`, edge-preserving noise reduction |
| Palette | `palette.ts` | edge-weighted histogram, k-means, `score = log10(err+1) + (K−2)·0.15` |
| Segment | `segmentation.ts` | Ward merges `Δ = \|S₁\|²/n₁ + \|S₂\|²/n₂ − \|S₁+S₂\|²/(n₁+n₂)` against a geometric λ ramp, boundary pixel swaps, min-size merging |
| Anti-aliasing | `subpixel.ts`, `antialias.ts` | pixels as blends of neighbouring segment colors (regularised projection, self-weight penalties); merge loops from small to large segments (interior error + boundary blend cost below a threshold), beach pixels, diagonal extrusions; color clustering of interior-less segments onto the 100 largest, palette snapping |
| Trace | `boundary.ts` | pixel-corner lattice → chains between junctions, shared by both regions (no gaps) |
| Smooth | `smooth.ts`, `raster.ts` | nonlinear CG over node positions; angular prior `sqrt(2−2cosθ+0.001)` + length uniformity; measurement = lattice tether (type 0) or exact-coverage render-and-compare `½Σ‖render−image‖²` (type 1); corner puncturing; sub-pixel node initialisation |
| Fit | `bezier.ts` | least-squares cubics with fixed ends; greedy merge (`err(A∪B) − err(A) − err(B)`) and boundary swaps under an annealed threshold |
| Export | `svg.ts` | per-region paths, stacked shapes, same-color seam strokes |

The renderer uses font-rs-style signed-area accumulation. Each chain segment is rasterized once with
weight `c_Q − c_P`, and a row prefix sum then gives every pixel's coverage-weighted color. The
measurement gradient is the analytic shape derivative `∫ r·(c_Q − c_P) n ds`, and the tests check it
against finite differences.

## Implementation notes

- **Classifier:** dominant-color count plus the fraction of blended edge pixels.
- **Noise reduction:** a median filter erodes corners, so this uses an edge-preserving neighbourhood mean.
- **Blend fringes:** after the merge loops, thin segments whose pixels are on average cheap blends of their neighbours are split pixel by pixel. Cross-hatching in scans is still handled less well (see `npm run test:reference`).
- **Pixel blend model:** the best blend with a single neighbouring segment.
- **Corner puncturing:** a decision tree over the turns of a 7-node window on each region outline.
- **Node initialisation:** a ±⅓ px shift from unmixing the 2×2 pixels around each node.
- **Speed and robustness:** the generative model only evaluates a 4 px band around the boundaries, and nodes may move at most 3 px.
- **SVG output:** stacked-shape hole filling, an underlay rectangle for opaque images, and a 0.35 px seam underlap (`--stroke`): a shape extends under the neighbours drawn on top of it, which hides hairline seams without moving visible edges.
- **Color clustering:** for anti-aliased artwork, only segments without real interior may take a large segment's color. For aliased artwork and photos, a greedy merge of colors within the margin; on for artwork, off for photos.

## Results (sample images, mean abs. premultiplied difference of the resvg render, 0–255)

| Image | Type | Regions | Curves | Error | Time |
|---|---|---|---|---|---|
| App icon 256 px | logo_aa | 8 | 40 | 0.96 | 1.6 s |
| App icon 1000 px | logo_aa | 11 | 137 | 0.72 | 10.1 s |
| Photo 240 px (q1) | photo | 173 | 578 | 4.69 | 0.4 s |
| Photo 800 px (q1) | photo | 1356 | 5068 | 3.68 | 2.8 s |

`scripts/compare.ts in.png out.svg side-by-side.png` reproduces these numbers.

### Comparison with reference SVGs

`npm run test:reference` vectorizes the images in `test/images` with the settings named in each
reference SVG's filename and compares outlines (to ¼ px), fragments, regions, paths and colors.
Our SVGs are written to `test/output/`.

| Reference | Edge match (ours / reference) | Mean edge distance | Paths (ours / reference) | Colors (ours / reference) |
|---|---|---|---|---|
| Color line art, unlimited colors | 0.999 / 1.000 | 0.025 px | 136 / 137 | 22 / 22 |
| B/W scan, 2 colors | 0.962 / 0.987 | 0.079 px | 494 / 463 | 2 / 2 |

The color reference passes every check except the fragment count: the tips of thin, tapering lines
break into specks in the test's non-anti-aliased render, 136 against 103 (limit 134). The B/W scan
still fails in its cross-hatched areas, which the reference renders as solid blobs with round holes.

### Disclaimer

This project and it's code is just for educational purpose. Commercial use is not allowed.  

[Link]: https://hotelroyale.github.io/vector-krum/
