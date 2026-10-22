import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

type Props = { open: boolean; title: string; closeLabel: string; onClose: () => void; children: ReactNode };

/** Native <dialog>: focus trapping, Escape to close and an inert background come from the browser. */
export function Dialog({ open, title, closeLabel, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-2xl rounded-2xl bg-white p-0 text-stone-900 shadow-2xl backdrop:bg-stone-900/40"
    >
      <div className="flex items-center justify-between border-b border-stone-200 px-6 py-4">
        <h2 id="dialog-title" className="text-lg font-semibold">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-800"
        >
          <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="max-h-[75vh] overflow-y-auto px-6 py-5">{children}</div>
    </dialog>
  );
}
