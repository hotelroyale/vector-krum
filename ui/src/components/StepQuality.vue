<script setup lang="ts">
import { computed } from 'vue';
import type { Quality } from '../../../src/browser';
import { state, next } from '../store';
import OptionCard from './OptionCard.vue';

const ARTWORK: { value: Quality; title: string; text: string }[] = [
  { value: 2, title: 'High', text: 'Sharp and clean, with few or no compression artifacts.' },
  { value: 1, title: 'Medium', text: 'Somewhat degraded, some compression artifacts or noise.' },
  { value: 0, title: 'Low', text: 'Blurry or heavily compressed. Smooths strongly.' },
];
const PHOTO: { value: Quality; title: string; text: string }[] = [
  { value: 2, title: 'High', text: 'Keep as many details as possible. Many small shapes.' },
  { value: 1, title: 'Medium', text: 'Keep some details, smooth the rest.' },
  { value: 0, title: 'Low', text: 'Few large shapes, strongly stylized.' },
];
const options = computed(() => (state.type === 'photo' ? PHOTO : ARTWORK));

function pick(q: Quality, go = false) {
  state.quality = q;
  if (go) next();
}
</script>

<template>
  <div class="options" role="radiogroup">
    <OptionCard
      v-for="o in options"
      :key="o.value"
      :title="o.title"
      :selected="state.quality === o.value"
      :recommended="o.value === 1"
      @select="pick(o.value)"
      @choose="pick(o.value, true)"
    >
      {{ o.text }}
    </OptionCard>
  </div>
</template>
