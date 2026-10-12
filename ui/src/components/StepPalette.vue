<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Color } from '../../../src/browser';
import { parseHexColor, toHexColor } from '../../../src/browser';
import { state, bestSuggestion } from '../store';
import Swatch from './Swatch.vue';

const MAX = 24;
const list = ref<HTMLElement>();
// Show the chosen (by default: best-fit) palette, which may be far down a long list.
watch(
  () => [state.suggestions, list.value],
  () => nextTick(() => list.value?.querySelector('.current')?.scrollIntoView({ block: 'nearest' })),
  { immediate: true },
);
const key = (cs: Color[]) => cs.map(toHexColor).join();
const currentKey = computed(() => key(state.palette));

function choose(colors: Color[]) {
  state.palette = colors.map((c) => [...c] as Color);
  state.activeSwatch = -1;
}

function add() {
  if (state.palette.length >= MAX) return;
  state.palette.push([0.5, 0.5, 0.5, 1]);
  state.activeSwatch = state.palette.length - 1;
}

function remove() {
  if (state.activeSwatch < 0) return;
  state.palette.splice(state.activeSwatch, 1);
  state.activeSwatch = Math.min(state.activeSwatch, state.palette.length - 1);
}

const activeHex = computed({
  get: () => (state.activeSwatch >= 0 ? toHexColor(state.palette[state.activeSwatch]).slice(0, 7) : '#000000'),
  set: (v: string) => {
    if (state.activeSwatch < 0) return;
    const alpha = state.palette[state.activeSwatch][3];
    state.palette[state.activeSwatch] = [...parseHexColor(v).slice(0, 3), alpha] as Color;
  },
});
</script>

<template>
  <div class="palette-step">
    <section>
      <h2 class="section-title">Suggested palettes</h2>
      <p v-if="state.suggesting" class="hint">Finding palettes…</p>
      <p v-else-if="!state.suggestions.length" class="hint">No suggestions for this image.</p>
      <ul v-else ref="list" class="suggestions">
        <li v-for="(s, i) in state.suggestions" :key="i">
          <button class="row" :class="{ current: key(s.colors) === currentKey }" @click="choose(s.colors)">
            <span class="best" :title="i === bestSuggestion ? 'Best fit' : undefined">{{ i === bestSuggestion ? '★' : '' }}</span>
            <span class="colors"><Swatch v-for="(c, j) in s.colors" :key="j" :color="c" :size="18" /></span>
          </button>
        </li>
      </ul>
      <p class="hint">Click a palette to use it. ★ marks the best fit.</p>
    </section>

    <section>
      <h2 class="section-title">Custom palette</h2>
      <div class="custom">
        <button
          v-for="(c, i) in state.palette"
          :key="i"
          class="swatch-btn"
          :aria-label="`Color ${i + 1}: ${toHexColor(c)}`"
          @click="state.activeSwatch = state.activeSwatch === i ? -1 : i"
        >
          <Swatch :color="c" :size="28" :active="state.activeSwatch === i" />
        </button>
        <button class="btn small add" :disabled="state.palette.length >= MAX" title="Add a color" @click="add">+</button>
      </div>
      <div v-if="state.activeSwatch >= 0" class="editor">
        <input v-model="activeHex" type="color" aria-label="Edit color" />
        <code>{{ toHexColor(state.palette[state.activeSwatch]) }}</code>
        <button class="btn small" :disabled="state.palette.length <= 2" @click="remove">Remove</button>
      </div>
      <p class="hint">
        {{ state.activeSwatch >= 0 ? 'Click in the image to pick this color, or edit it here.' : 'Select a color to change it.' }}
        {{ state.palette.length < 2 ? 'At least two colors are needed.' : '' }}
      </p>
    </section>
  </div>
</template>

<style scoped lang="scss">
.palette-step {
  display: grid;
  gap: 22px;

  section {
    display: grid;
    gap: 8px;
  }
}

.suggestions {
  display: grid;
  max-height: 360px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.row {
  display: flex;
  align-items: center;
  width: 100%;

  .colors {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }

  padding: 5px 6px;
  border-radius: var(--radius-sm);

  &:hover {
    background: var(--subtle);
  }

  &.current {
    box-shadow: inset 0 0 0 1.5px var(--text);
  }
}

.best {
  flex: none;
  width: 18px;
  font-size: 12px;
}

.custom {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);

  .add {
    width: 28px;
    min-height: 28px;
    padding: 0;
    font-size: 18px;
  }
}

.swatch-btn {
  display: flex;
}

.editor {
  display: flex;
  align-items: center;
  gap: 10px;

  input[type='color'] {
    width: 44px;
    height: 30px;
    border: 0;
    padding: 0;
    background: none;
    cursor: pointer;
  }

  code {
    font-family: var(--mono);
    font-size: 13px;
  }

  .btn {
    margin-left: auto;
  }
}
</style>
