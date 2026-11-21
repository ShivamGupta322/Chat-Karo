import { useEffect, useId, useRef } from 'react';

export interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// A custom alertdialog: jsdom does not implement HTMLDialogElement.showModal, and the focus rules are small.
// Focus starts on Cancel (the safe default for a destructive action) and returns to the opener on unmount.
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancelRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const first = cancelRef.current;
      const last = confirmRef.current;
      if (!first || !last) return;
      const active = document.activeElement;
      if (active !== first && active !== last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener?.isConnected === true) opener.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-20 grid place-items-center bg-ink/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="grid w-full max-w-sm gap-4 rounded-2xl border border-line bg-surface p-5 shadow-sm"
      >
        <h2 id={titleId} className="m-0 text-base font-semibold">
          {title}
        </h2>
        <p id={bodyId} className="m-0 text-sm text-ink-muted">
          {body}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-field bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-sunken"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="rounded-lg border border-danger bg-surface px-3 py-2 text-sm font-medium text-danger hover:bg-surface-sunken"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
