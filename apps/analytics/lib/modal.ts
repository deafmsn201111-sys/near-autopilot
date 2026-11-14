/**
 * A modal <dialog> sits in the top layer and makes any wallet sheet or iframe outside it inert: drop to non-modal while
 * one may be open, then back.
 */
export async function withoutModal<T>(
  dialog: HTMLDialogElement | null,
  run: () => Promise<T>,
): Promise<T> {
  if (!dialog?.open) return run();
  dialog.close();
  dialog.show();
  try {
    return await run();
  } finally {
    if (dialog.open && dialog.isConnected) {
      dialog.close();
      dialog.showModal();
    }
  }
}
