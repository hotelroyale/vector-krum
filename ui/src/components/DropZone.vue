<script setup lang="ts">
import { ref } from 'vue';
import { state, openFile } from '../store';

const input = ref<HTMLInputElement>();
function onPick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) openFile(file);
  (e.target as HTMLInputElement).value = '';
}
</script>

<template>
  <div class="dropzone" @click="input?.click()">
    <div class="inner">
      <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
        <rect x="6" y="10" width="36" height="28" rx="4" fill="none" stroke="currentColor" stroke-width="2.5" />
        <path d="M12 32l9-9 6 6 4-4 6 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" />
        <circle cx="31" cy="18" r="3" fill="currentColor" />
      </svg>
      <p class="title">{{ state.loading ? 'Reading image…' : 'Drop an image here' }}</p>
      <p class="hint">or <button class="link" @click.stop="input?.click()">choose a file</button> · PNG, JPEG, GIF, WebP, BMP</p>
    </div>
    <input ref="input" type="file" accept="image/*" hidden @change="onPick" />
  </div>
</template>

<style scoped lang="scss">
.dropzone {
  position: absolute;
  inset: 24px;
  display: grid;
  place-items: center;
  border: 1.5px dashed var(--border-strong);
  border-radius: 16px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;

  &:hover {
    border-color: var(--text);
  }
}

.inner {
  display: grid;
  justify-items: center;
  gap: 6px;
  color: var(--muted);

  .title {
    margin-top: 8px;
    font-size: 18px;
    font-weight: 500;
    color: var(--text);
  }
}
</style>
