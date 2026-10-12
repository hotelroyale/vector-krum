<script setup lang="ts">
import { computed, ref } from 'vue';
import { state, steps, next, back, startPage, openFile } from './store';
import Viewer from './components/Viewer.vue';
import DropZone from './components/DropZone.vue';
import StepType from './components/StepType.vue';
import StepQuality from './components/StepQuality.vue';
import StepTransparency from './components/StepTransparency.vue';
import StepColors from './components/StepColors.vue';
import StepPalette from './components/StepPalette.vue';
import StepResult from './components/StepResult.vue';

const TITLES = {
  start: 'Vectorize an image',
  type: 'Image Type',
  quality: 'Input Quality',
  transparency: 'Transparency',
  colors: 'Color Mode',
  palette: 'Palette Selection',
  result: 'Review Result',
} as const;

const STEP_COMPONENTS = {
  type: StepType,
  quality: StepQuality,
  transparency: StepTransparency,
  colors: StepColors,
  palette: StepPalette,
  result: StepResult,
};

const title = computed(() => (state.step === 'quality' && state.type === 'photo' ? 'Level of Detail' : TITLES[state.step]));
const stepIndex = computed(() => steps.value.indexOf(state.step));
const canNext = computed(() => state.step !== 'palette' || state.palette.length >= 2);

// Drop an image anywhere, at any time.
const dragging = ref(false);
let dragDepth = 0;
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
function onDragEnter(e: DragEvent) {
  if (!hasFiles(e)) return;
  dragDepth++;
  dragging.value = true;
}
function onDragLeave() {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dragging.value = false;
  }
}
function onDrop(e: DragEvent) {
  dragDepth = 0;
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) openFile(file);
}
</script>

<template>
  <div class="app" @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop">
    <main class="stage">
      <Viewer v-if="state.image" />
      <DropZone v-else />
    </main>

    <aside class="panel">
      <header class="panel-head">
        <h1>{{ title }}</h1>
        <ol v-if="stepIndex >= 0" class="progress" :aria-label="`Step ${stepIndex + 1} of ${steps.length}`">
          <li v-for="(s, i) in steps" :key="s" :class="{ done: i < stepIndex, current: i === stepIndex }" />
        </ol>
      </header>

      <section class="panel-body">
        <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
        <div v-if="state.step === 'start'" class="intro">
          <p>Turn a pixel image into a clean SVG.</p>
          <ol>
            <li>Drop an image or choose a file.</li>
            <li>Answer a few questions about it.</li>
            <li>Review the result and download the SVG.</li>
          </ol>
          <p class="hint">Everything runs locally in your browser; the image is not uploaded.</p>
        </div>
        <component :is="STEP_COMPONENTS[state.step]" v-else />
      </section>

      <footer v-if="state.step !== 'start'" class="panel-foot">
        <button class="btn ghost" @click="startPage">Start</button>
        <button class="btn" :disabled="stepIndex <= 0" @click="back">Back</button>
        <button v-if="state.step !== 'result'" class="btn primary" :disabled="!canNext" @click="next">Next</button>
      </footer>
    </aside>

    <div v-if="dragging" class="drop-overlay">
      <div>Drop the image to vectorize it</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.app {
  display: grid;
  grid-template-columns: 1fr var(--panel-width);
  height: 100dvh;

  @media (width < 800px) {
    grid-template-columns: 1fr;
    grid-template-rows: 55dvh 1fr;
  }
}

.stage {
  position: relative;
  min-width: 0;
  min-height: 0;
}

.panel {
  display: grid;
  grid-template-rows: auto 1fr auto;
  min-height: 0;
  background: var(--surface);
  border-left: 1px solid var(--border);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 22px 24px 8px;

  h1 {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
}

.progress {
  display: flex;
  gap: 5px;

  li {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--border-strong);

    &.done {
      background: var(--muted);
    }

    &.current {
      background: var(--text);
      width: 18px;
      border-radius: 4px;
    }
  }
}

.panel-body {
  overflow-y: auto;
  padding: 12px 24px 24px;
}

.panel-foot {
  display: flex;
  gap: 8px;
  padding: 16px 24px 20px;

  .btn.primary {
    margin-left: auto;
    min-width: 96px;
  }

  .btn:nth-child(2):last-child {
    margin-left: auto;
  }
}

.error {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: #fdf0ef;
  color: var(--danger);
}

.intro {
  display: grid;
  gap: 14px;

  ol {
    list-style: decimal;
    padding-left: 1.3em;
    display: grid;
    gap: 4px;
  }
}

.drop-overlay {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgb(255 255 255 / 0.75);
  backdrop-filter: blur(3px);
  pointer-events: none;
  z-index: 10;

  div {
    padding: 18px 28px;
    border: 1.5px dashed var(--text);
    border-radius: var(--radius);
    background: var(--surface);
    font-size: 16px;
    font-weight: 500;
  }
}
</style>
