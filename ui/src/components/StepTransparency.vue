<script setup lang="ts">
import { computed } from 'vue';
import type { Color } from '../../../src/browser';
import { parseHexColor, toHexColor } from '../../../src/browser';
import { state, next } from '../store';
import OptionCard from './OptionCard.vue';

const WHITE: Color = [1, 1, 1, 1];
const BLACK: Color = [0, 0, 0, 1];
const same = (a: Color, b: Color) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
const kind = computed(() =>
  state.transparency === 'keep' ? 'keep' : same(state.transparency, WHITE) ? 'white' : same(state.transparency, BLACK) ? 'black' : 'custom',
);
const custom = computed({
  get: () => (kind.value === 'custom' && state.transparency !== 'keep' ? toHexColor(state.transparency).slice(0, 7) : '#808080'),
  set: (v: string) => (state.transparency = [...parseHexColor(v).slice(0, 3), 1] as Color),
});
function pick(t: 'keep' | Color, go = false) {
  state.transparency = t;
  if (go) next();
}
</script>

<template>
  <div class="options" role="radiogroup">
    <p class="hint">This image has transparent areas.</p>
    <OptionCard title="Keep transparency" :selected="kind === 'keep'" recommended @select="pick('keep')" @choose="pick('keep', true)">
      Transparent areas stay empty in the SVG.
    </OptionCard>
    <OptionCard title="Fill with white" :selected="kind === 'white'" @select="pick(WHITE)" @choose="pick(WHITE, true)">
      Place the image on a white background first.
    </OptionCard>
    <OptionCard title="Fill with black" :selected="kind === 'black'" @select="pick(BLACK)" @choose="pick(BLACK, true)">
      Place the image on a black background first.
    </OptionCard>
    <OptionCard title="Fill with a color" :selected="kind === 'custom'" @select="custom = custom">
      Place the image on a background of your choice.
      <template #extra>
        <label class="pick" @click.stop @dblclick.stop>
          <input v-model.lazy="custom" type="color" />
          <code>{{ custom }}</code>
        </label>
      </template>
    </OptionCard>
  </div>
</template>

<style scoped lang="scss">
.pick {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 13px;

  input {
    width: 32px;
    height: 22px;
    border: 0;
    padding: 0;
    background: none;
    cursor: pointer;
  }

  code {
    font-family: var(--mono);
    color: var(--muted);
  }
}
</style>
