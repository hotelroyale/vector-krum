<script setup lang="ts">
import type { ImageType } from '../../../src/browser';
import { state, recommendedType, next, recommendedColorMode } from '../store';
import OptionCard from './OptionCard.vue';

const OPTIONS: { value: ImageType; title: string; text: string }[] = [
  { value: 'logo_aa', title: 'Artwork with smooth edges', text: 'Logos, icons, drawings. Edges are anti-aliased (soft, 1–2 px blend). The most common case.' },
  { value: 'logo', title: 'Artwork with hard edges', text: 'Pixel art, GIFs, screenshots. Every pixel is one exact color; zoom in on an edge to check.' },
  { value: 'photo', title: 'Photograph', text: 'Taken with a camera, or detailed with gradients and textures.' },
];

function pick(t: ImageType, go = false) {
  if (state.type !== t) {
    state.type = t;
    state.colorMode = recommendedColorMode.value;
  }
  if (go) next();
}
</script>

<template>
  <div class="options" role="radiogroup">
    <OptionCard
      v-for="o in OPTIONS"
      :key="o.value"
      :title="o.title"
      :selected="state.type === o.value"
      :recommended="recommendedType === o.value"
      @select="pick(o.value)"
      @choose="pick(o.value, true)"
    >
      {{ o.text }}
    </OptionCard>
  </div>
</template>
