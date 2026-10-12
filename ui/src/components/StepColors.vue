<script setup lang="ts">
import type { ColorMode } from '../store';
import { state, next, recommendedColorMode } from '../store';
import OptionCard from './OptionCard.vue';

const OPTIONS: { value: ColorMode; title: string; text: string }[] = [
  { value: 'two', title: 'Two colors', text: 'Only two colors, e.g. black on white.' },
  { value: 'custom', title: 'Custom colors', text: 'Review suggested palettes and use only the colors you choose. Removes noise and blur.' },
  { value: 'unlimited', title: 'Unlimited colors', text: 'Use every color needed. Good for gradients, but keeps noise.' },
];

function pick(m: ColorMode, go = false) {
  state.colorMode = m;
  if (go) next();
}
</script>

<template>
  <div class="options" role="radiogroup">
    <OptionCard
      v-for="o in OPTIONS"
      :key="o.value"
      :title="o.title"
      :selected="state.colorMode === o.value"
      :recommended="recommendedColorMode === o.value"
      @select="pick(o.value)"
      @choose="pick(o.value, true)"
    >
      {{ o.text }}
    </OptionCard>
  </div>
</template>
