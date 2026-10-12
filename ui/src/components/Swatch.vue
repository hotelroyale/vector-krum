<script setup lang="ts">
import { computed } from 'vue';
import type { Color } from '../../../src/browser';

const props = defineProps<{ color: Color; size?: number; active?: boolean }>();
const css = computed(() => {
  const [r, g, b, a] = props.color;
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)} / ${a})`;
});
</script>

<template>
  <span class="swatch" :class="{ active }" :style="{ '--c': css, '--s': `${size ?? 22}px` }" />
</template>

<style scoped lang="scss">
.swatch {
  display: inline-block;
  flex: none;
  width: var(--s);
  height: var(--s);
  border-radius: 4px;
  // Checkerboard behind semi-transparent colors.
  background:
    linear-gradient(var(--c), var(--c)),
    repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 0 0 / 8px 8px;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.18);

  &.active {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
}
</style>
