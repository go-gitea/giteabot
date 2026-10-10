// delays calling fn until wait ms have passed since the last call, using the
// arguments of the last call
export const debounce = <T extends unknown[]>(
  fn: (...args: T) => unknown,
  wait: number,
) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return (...args: T) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = undefined;
      fn(...args);
    }, wait);
  };
};
