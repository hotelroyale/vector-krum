<script setup lang="ts">
// Image viewer: bitmap, vector or both side by side (split), with zoom, pan, a paths overlay
// (outlines and curve nodes) and color picking for the custom palette.
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { ViewMode } from '../store';
import { state, pixelColor } from '../store';

const el = ref<HTMLDivElement>();
const overlay = ref<HTMLCanvasElement>();

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 32;

const view = reactive({ width: 0, height: 0, zoom: 1, x: 0, y: 0, fit: true, split: 0.5 });

const imgW = computed(() => state.image?.pixels.width ?? 1);
const imgH = computed(() => state.image?.pixels.height ?? 1);

/** SVG markup without the XML prolog, and its size in image pixels. */
const vector = computed(() => {
  const svg = state.result?.svg;
  if (!svg) return null;
  const m = /<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"/.exec(svg);
  return { markup: svg.replace(/^<\?xml[^>]*>\s*/, ''), width: m ? Number(m[1]) : imgW.value, height: m ? Number(m[2]) : imgH.value };
});

/** Filled paths of the result, for the outline overlay. */
const outlines = computed(() => {
  const svg = state.result?.svg;
  if (!svg) return [];
  return [...svg.matchAll(/<path fill="#[^"]*"[^>]*\sd="([^"]*)"/g)].map((m) => new Path2D(m[1]));
});

const canVector = computed(() => !!state.result);
const mode = computed<ViewMode>(() => (canVector.value ? state.view : 'bitmap'));
const showsVector = computed(() => mode.value !== 'bitmap' && !!vector.value);
const splitX = computed(() => view.split * view.width);
const picking = computed(() => state.step === 'palette' && state.activeSwatch >= 0);

function fit() {
  const pad = 32;
  const z = Math.min((view.width - 2 * pad) / imgW.value, (view.height - 2 * pad) / imgH.value);
  view.zoom = Math.min(Math.max(z, MIN_ZOOM), 8);
  view.x = (view.width - imgW.value * view.zoom) / 2;
  view.y = (view.height - imgH.value * view.zoom) / 2;
  view.fit = true;
}

function zoomAt(z: number, cx = view.width / 2, cy = view.height / 2) {
  z = Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM);
  view.x = cx - ((cx - view.x) * z) / view.zoom;
  view.y = cy - ((cy - view.y) * z) / view.zoom;
  view.zoom = z;
  view.fit = false;
}

const layerStyle = computed(() => ({
  left: `${view.x}px`,
  top: `${view.y}px`,
  width: `${imgW.value * view.zoom}px`,
  height: `${imgH.value * view.zoom}px`,
}));

const vectorStyle = computed(() => {
  const v = vector.value;
  const style: Record<string, string> = {
    left: `${view.x}px`,
    top: `${view.y}px`,
    width: `${(v?.width ?? imgW.value) * view.zoom}px`,
    height: `${(v?.height ?? imgH.value) * view.zoom}px`,
  };
  if (mode.value === 'split') style.clipPath = `inset(0 0 0 ${Math.max(0, splitX.value - view.x)}px)`;
  return style;
});

// Zoom slider works on a log scale.
const sliderValue = computed({
  get: () => Math.log(view.zoom),
  set: (v: number) => zoomAt(Math.exp(v)),
});

// Pointer: drag pans, a click without movement picks a color (palette step), dragging the
// split handle moves the divider.
let drag: { id: number; sx: number; sy: number; x: number; y: number; moved: boolean } | null = null;

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  el.value!.setPointerCapture(e.pointerId);
  drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: view.x, y: view.y, moved: false };
}

function onPointerMove(e: PointerEvent) {
  if (!drag || drag.id !== e.pointerId) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  view.x = drag.x + dx;
  view.y = drag.y + dy;
  view.fit = false;
}

function onPointerUp(e: PointerEvent) {
  if (!drag || drag.id !== e.pointerId) return;
  const click = !drag.moved;
  drag = null;
  if (click && picking.value) {
    const r = el.value!.getBoundingClientRect();
    const c = pixelColor((e.clientX - r.left - view.x) / view.zoom, (e.clientY - r.top - view.y) / view.zoom);
    if (c) state.palette[state.activeSwatch] = c[3] < 1 / 255 ? [1, 1, 1, 0] : c;
  }
}

function onDividerDown(e: PointerEvent) {
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    const r = el.value!.getBoundingClientRect();
    view.split = Math.min(0.98, Math.max(0.02, (ev.clientX - r.left) / r.width));
  };
  const up = () => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
}

function onWheel(e: WheelEvent) {
  const r = el.value!.getBoundingClientRect();
  // Pinch-zoom on trackpads arrives as wheel events with ctrlKey; scale it up.
  const k = e.ctrlKey ? 0.01 : 0.0015;
  zoomAt(view.zoom * Math.exp(-e.deltaY * k), e.clientX - r.left, e.clientY - r.top);
}

function setMode(m: ViewMode) {
  if (m !== 'bitmap' && !canVector.value) return;
  state.view = m;
}

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  if (k === 'b') setMode('bitmap');
  else if (k === 'v') setMode('vector');
  else if (k === 's') setMode('split');
  else if (k === 'p' && canVector.value) state.showPaths = !state.showPaths;
  else if (k === '0') fit();
  else if (k === '1') zoomAt(1);
  else if (k === '+' || k === '=') zoomAt(view.zoom * 1.25);
  else if (k === '-') zoomAt(view.zoom / 1.25);
  else return;
  e.preventDefault();
}

// Paths overlay ------------------------------------------------------------------------------------

let frame = 0;
function scheduleDraw() {
  if (!frame) frame = requestAnimationFrame(draw);
}

function draw() {
  frame = 0;
  const canvas = overlay.value;
  if (!canvas) return;
  const dpr = devicePixelRatio || 1;
  const w = Math.round(view.width * dpr);
  const h = Math.round(view.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!state.showPaths || !showsVector.value || !state.result) return;

  ctx.save();
  if (mode.value === 'split') {
    ctx.beginPath();
    ctx.rect(splitX.value * dpr, 0, w, h);
    ctx.clip();
  }
  const paths = getComputedStyle(canvas).getPropertyValue('--paths').trim() || '#00c2d6';
  ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y);
  ctx.strokeStyle = paths;
  ctx.lineWidth = 1.25 / view.zoom;
  ctx.lineJoin = 'round';
  for (const p of outlines.value) ctx.stroke(p);

  // Nodes: small squares of constant screen size, only if they are not too crowded.
  const nodes = state.result.nodes;
  const s = 4 * dpr;
  if (view.zoom * Math.sqrt((imgW.value * imgH.value) / Math.max(1, nodes.length / 2)) > 6) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = paths;
    for (let i = 0; i < nodes.length; i += 2) {
      const x = (view.x + nodes[i] * view.zoom) * dpr;
      const y = (view.y + nodes[i + 1] * view.zoom) * dpr;
      if (x < -s || y < -s || x > w + s || y > h + s) continue;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
  }
  ctx.restore();
}

watch(() => [view.x, view.y, view.zoom, view.width, view.height, view.split, state.showPaths, mode.value, state.result], scheduleDraw);

// New image: fit it. Resizing the viewer keeps the fit if the user has not zoomed or panned.
watch(() => state.image, () => fit());

let observer: ResizeObserver;
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    view.width = entry.contentRect.width;
    view.height = entry.contentRect.height;
    if (view.fit) fit();
    scheduleDraw();
  });
  observer.observe(el.value!);
  window.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  observer.disconnect();
  window.removeEventListener('keydown', onKey);
  cancelAnimationFrame(frame);
});

const zoomLabel = computed(() => `${Math.round(view.zoom * 100)}%`);
</script>

<template>
  <div
    ref="el"
    class="viewer"
    :class="{ picking, panning: !picking }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel.prevent="onWheel"
  >
    <div v-show="mode !== 'vector' || !showsVector" class="layer bitmap" :style="layerStyle">
      <img :src="state.image!.url" alt="" draggable="false" :class="{ pixelated: view.zoom >= 2 }" />
    </div>
    <div v-if="showsVector" class="layer vector" :style="vectorStyle" v-html="vector!.markup" />
    <canvas ref="overlay" class="overlay" />

    <template v-if="mode === 'split' && showsVector">
      <div class="divider" :style="{ left: `${splitX}px` }" @pointerdown.stop="onDividerDown">
        <span class="grip" />
      </div>
      <span class="label left">Bitmap</span>
      <span class="label right">Vector</span>
    </template>

    <div v-if="state.busy" class="busy">
      <span class="spinner" />
      {{ state.stage || 'Vectorizing' }}…
    </div>

    <div class="toolbar" @pointerdown.stop @wheel.stop>
      <div class="group">
        <button class="btn small" :class="{ active: mode === 'bitmap' }" title="Bitmap (B)" @click="setMode('bitmap')">Bitmap</button>
        <button class="btn small" :class="{ active: mode === 'vector' }" :disabled="!canVector" title="Vector (V)" @click="setMode('vector')">Vector</button>
        <button class="btn small" :class="{ active: mode === 'split' }" :disabled="!canVector" title="Split view (S)" @click="setMode('split')">Split</button>
      </div>
      <label class="check" :class="{ disabled: !canVector }" title="Show paths (P)">
        <input v-model="state.showPaths" type="checkbox" :disabled="!canVector" /> Paths
      </label>
      <span class="sep" />
      <div class="group zoom">
        <button class="btn small ghost" title="Zoom out (−)" @click="zoomAt(view.zoom / 1.25)">−</button>
        <input v-model.number="sliderValue" type="range" :min="Math.log(MIN_ZOOM)" :max="Math.log(MAX_ZOOM)" step="0.01" aria-label="Zoom" />
        <button class="btn small ghost" title="Zoom in (+)" @click="zoomAt(view.zoom * 1.25)">+</button>
        <button class="btn small ghost value" title="Actual size (1)" @click="zoomAt(1)">{{ zoomLabel }}</button>
        <button class="btn small ghost" title="Fit (0)" @click="fit">Fit</button>
      </div>
    </div>

    <p v-if="picking" class="pick-hint">Click in the image to pick color {{ state.activeSwatch + 1 }}</p>
  </div>
</template>

<style scoped lang="scss">
.viewer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: var(--checker);
  touch-action: none;
  user-select: none;

  &.panning {
    cursor: grab;

    &:active {
      cursor: grabbing;
    }
  }

  &.picking {
    cursor: crosshair;
  }
}

.layer {
  position: absolute;
  pointer-events: none;

  img {
    width: 100%;
    height: 100%;

    &.pixelated {
      image-rendering: pixelated;
    }
  }

  &.vector :deep(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }
}

.overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 16px;
  margin-left: -8px;
  cursor: ew-resize;
  touch-action: none;

  &::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 7px;
    width: 2px;
    background: var(--accent);
  }

  .grip {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 22px;
    height: 40px;
    translate: -50% -50%;
    border-radius: 11px;
    background: var(--accent);
    box-shadow: var(--shadow);

    &::before {
      content: '';
      position: absolute;
      inset: 12px 7px;
      border-inline: 2px solid rgb(255 255 255 / 0.85);
    }
  }
}

.label {
  position: absolute;
  top: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgb(0 0 0 / 0.6);
  color: white;
  font-size: 12px;
  pointer-events: none;

  &.left {
    left: 12px;
  }

  &.right {
    right: 12px;
  }
}

.toolbar {
  position: absolute;
  left: 50%;
  bottom: 16px;
  translate: -50% 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: rgb(255 255 255 / 0.92);
  backdrop-filter: blur(8px);
  box-shadow: var(--shadow);
  cursor: default;
  white-space: nowrap;

  .group {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .sep {
    width: 1px;
    align-self: stretch;
    background: var(--border);
  }

  .check {
    font-size: 13px;

    &.disabled {
      opacity: 0.4;
    }
  }

  .zoom {
    input[type='range'] {
      width: 110px;
      accent-color: var(--accent);
    }

    .value {
      min-width: 56px;
      font-variant-numeric: tabular-nums;
    }
  }
}

.busy {
  position: absolute;
  top: 16px;
  left: 50%;
  translate: -50% 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgb(0 0 0 / 0.75);
  color: white;
  font-size: 13px;
  pointer-events: none;

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgb(255 255 255 / 0.35);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
}

@keyframes spin {
  to {
    rotate: 1turn;
  }
}

.pick-hint {
  position: absolute;
  top: 16px;
  left: 16px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  background: var(--text);
  color: white;
  font-size: 13px;
  pointer-events: none;
}
</style>
