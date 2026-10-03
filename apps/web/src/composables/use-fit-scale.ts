import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

import { fitScale } from "../shell/shell-view.js";

/**
 * Follows the width of `container` and returns the scale that fits the 1280×720 screen into it
 * (mock `fit()` on window resize). Stays at 1 until the container is mounted.
 */
export const useFitScale = (
  container: Readonly<Ref<HTMLElement | null>>,
): Readonly<Ref<number>> => {
  const scale = ref(1);
  let observer: ResizeObserver | null = null;

  const measure = (): void => {
    if (container.value !== null) scale.value = fitScale(container.value.clientWidth);
  };

  onMounted(() => {
    measure();
    if (container.value === null) return;
    observer = new ResizeObserver(measure);
    observer.observe(container.value);
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
  });

  return scale;
};
