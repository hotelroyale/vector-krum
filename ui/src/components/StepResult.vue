<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import type { Quality } from '../../../src/browser';
import type { ColorMode } from '../store';
import { state, rerun, goTo, downloadSvg, loadSuggestions } from '../store';
import Swatch from './Swatch.vue';

const DETAIL: { value: Quality; name: string; title: string }[] = [
  { value: 2, name: 'High', title: 'Preserve as many details as possible.' },
  { value: 1, name: 'Medium', title: 'Preserve some details but do some smoothing.' },
  { value: 0, name: 'Low', title: 'Strong smoothing, details lost but robust to blurry and low-quality source images.' },
];

const stats = computed(() => {
  const svg = state.result?.svg;
  if (!svg) return null;
  const fills = new Set(svg.match(/<path fill="#[0-9a-f]{6}/g) ?? []);
  const paths = (svg.match(/<path fill="#/g) ?? []).length;
  const kb = new Blob([svg]).size / 1024;
  return { paths, colors: fills.size, size: kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB` };
});

const resultPalette = computed(() => state.result?.palette ?? null);

async function setColors(mode: ColorMode) {
  if (mode === 'custom') {
    if (!state.palette.length) await loadSuggestions();
    if (state.palette.length < 2) return goTo('palette');
  }
  rerun(() => (state.colorMode = mode));
}

function changePalette() {
  state.colorMode = 'custom';
  goTo('palette');
}

// Hand-picked settings are edited in a draft and applied together.
const draft = reactive({ maxSide: 0, strokeWidth: 0.35, stacked: true, clusterColors: 'default' as 'default' | 'on' | 'off' });
function resetDraft() {
  draft.maxSide = state.maxSide;
  draft.strokeWidth = state.strokeWidth;
  draft.stacked = state.stacked;
  draft.clusterColors = state.clusterColors === undefined ? 'default' : state.clusterColors ? 'on' : 'off';
}
resetDraft();
watch(() => [state.maxSide, state.strokeWidth, state.stacked, state.clusterColors], resetDraft);

const dirty = computed(
  () =>
    draft.maxSide !== state.maxSide ||
    draft.strokeWidth !== state.strokeWidth ||
    draft.stacked !== state.stacked ||
    draft.clusterColors !== (state.clusterColors === undefined ? 'default' : state.clusterColors ? 'on' : 'off'),
);

function apply() {
  rerun(() => {
    state.maxSide = Math.max(0, Math.round(Number(draft.maxSide) || 0));
    state.strokeWidth = Math.max(0, Number(draft.strokeWidth) || 0);
    state.stacked = draft.stacked;
    state.clusterColors = draft.clusterColors === 'default' ? undefined : draft.clusterColors === 'on';
  });
}
</script>

<template>
  <div class="result-step">
    <div class="done" :class="{ ready: state.result && !state.busy }">
      <div class="status">
        <template v-if="state.busy">
          <span class="spinner" aria-hidden="true" />
          <div>
            <strong>Vectorizing…</strong>
            <p class="hint">{{ state.stage || 'Starting' }}</p>
          </div>
        </template>
        <template v-else-if="state.result">
          <svg class="done-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" /><path d="M7 12.5l3.2 3.2L17 9" /></svg>
          <div>
            <strong>Done</strong>
            <p v-if="stats" class="hint">{{ stats.paths }} shapes · {{ stats.colors }} colors · {{ stats.size }}</p>
          </div>
        </template>
        <p v-else class="hint">No result yet.</p>
      </div>
      <button class="btn primary download" :disabled="!state.result || state.busy" @click="downloadSvg">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        Download SVG
      </button>
    </div>

    <section>
      <h2 class="section-title">Detail level</h2>
      <div class="segmented">
        <button
          v-for="d in DETAIL"
          :key="d.value"
          class="btn"
          :class="{ active: state.quality === d.value }"
          :title="d.title"
          @click="rerun(() => (state.quality = d.value))"
        >
          {{ d.name }}
        </button>
      </div>
    </section>

    <section>
      <h2 class="section-title">Colors</h2>
      <div class="segmented">
        <button class="btn" :class="{ active: state.colorMode === 'two' }" @click="setColors('two')">Two</button>
        <button class="btn" :class="{ active: state.colorMode === 'custom' }" @click="setColors('custom')">Custom</button>
        <button class="btn" :class="{ active: state.colorMode === 'unlimited' }" @click="setColors('unlimited')">Unlimited</button>
      </div>
      <div v-if="resultPalette && state.colorMode !== 'unlimited'" class="current-palette">
        <span class="hint">Current palette (<button class="link" @click="changePalette">change</button>):</span>
        <div class="swatches">
          <Swatch v-for="(c, i) in resultPalette" :key="i" :color="c" :size="20" />
        </div>
      </div>
    </section>

    <details class="advanced" @toggle="resetDraft">
      <summary class="section-title">Hand-pick settings</summary>
      <div class="fields">
        <label class="field">
          <span>Working size, longer side in px (0 = automatic, ≤ 1.6 MP)</span>
          <input v-model.number="draft.maxSide" type="number" min="0" max="10000" step="50" />
        </label>
        <label class="field">
          <span>Seam underlap in px (hides hairline gaps; 0 = none)</span>
          <input v-model.number="draft.strokeWidth" type="number" min="0" max="5" step="0.05" />
        </label>
        <label class="check"><input v-model="draft.stacked" type="checkbox" /> Stack shapes (fill holes covered by shapes on top)</label>
        <label v-if="state.colorMode === 'unlimited'" class="field">
          <span>Unify similar colors</span>
          <select v-model="draft.clusterColors">
            <option value="default">Default ({{ state.type === 'photo' ? 'off' : 'on' }} for this image type)</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
        <button class="btn" :disabled="!dirty" @click="apply">Apply and re-vectorize</button>
      </div>
    </details>
  </div>
</template>

<style scoped lang="scss">
.result-step {
  display: grid;
  gap: 22px;

  section {
    display: grid;
    gap: 8px;
  }
}

.done {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);

  .status {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 40px;

    strong {
      font-size: 15px;
    }
  }

  .download {
    min-height: 40px;
    font-size: 15px;
  }
}

.done-icon {
  width: 36px;
  height: 36px;
  flex: none;

  circle {
    fill: var(--text);
  }

  path {
    fill: none;
    stroke: white;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
}

.spinner {
  width: 32px;
  height: 32px;
  flex: none;
  margin: 2px;
  border: 3px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    rotate: 1turn;
  }
}

.segmented {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 6px;
}

.current-palette {
  display: grid;
  gap: 6px;

  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
}

.advanced {
  border-top: 1px solid var(--border);
  padding-top: 14px;

  summary {
    cursor: pointer;
    list-style-position: inside;
    font-weight: 600;
  }

  .fields {
    display: grid;
    gap: 12px;
    margin-top: 12px;
  }

  select {
    height: 32px;
    padding: 0 6px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
}
</style>
