/** Blocks Electron quit until cleanup finishes; repeated quit requests share the same cleanup. */
export const makeQuitHandler = (options: {
  readonly dispose: () => Promise<void>;
  readonly quit: () => void;
  readonly onError: (error: unknown) => void;
}) => {
  let complete = false;
  let pending: Promise<void> | undefined;
  return (event: { preventDefault(): void }): Promise<void> | undefined => {
    if (complete) return;
    event.preventDefault();
    pending ??= Promise.resolve()
      .then(options.dispose)
      .catch(options.onError)
      .finally(() => {
        complete = true;
        options.quit();
      });
    return pending;
  };
};
