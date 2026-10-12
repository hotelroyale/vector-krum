<script setup lang="ts">
defineProps<{ title: string; recommended?: boolean; selected?: boolean }>();
const emit = defineEmits<{ select: []; choose: [] }>();
</script>

<template>
  <div
    class="option"
    :class="{ selected }"
    role="radio"
    tabindex="0"
    :aria-checked="selected"
    @click="emit('select')"
    @dblclick="emit('choose')"
    @keydown.enter.prevent="emit('choose')"
    @keydown.space.prevent="emit('select')"
  >
    <span class="radio" aria-hidden="true" />
    <div class="text">
      <div class="head">
        <h3>{{ title }}</h3>
        <span v-if="recommended" class="badge">Recommended</span>
      </div>
      <p><slot /></p>
      <slot name="extra" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.option {
  display: grid;
  grid-template-columns: 18px 1fr;
  gap: 12px;
  padding: 14px 14px 14px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  user-select: none;
  transition: border-color 0.12s;

  &:hover {
    border-color: var(--border-strong);
  }

  &.selected {
    border-color: var(--text);
    box-shadow: inset 0 0 0 1px var(--text);
  }
}

.radio {
  width: 16px;
  height: 16px;
  margin-top: 2px;
  border: 1.5px solid var(--border-strong);
  border-radius: 50%;
  transition: border 0.12s;

  .selected & {
    border: 5px solid var(--text);
  }
}

.text {
  display: grid;
  gap: 2px;
  min-width: 0;

  h3 {
    font-size: 14px;
    font-weight: 600;
  }

  p {
    font-size: 13px;
    color: var(--muted);
  }
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.badge {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--subtle);
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
}
</style>
