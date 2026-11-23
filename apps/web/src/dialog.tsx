import { useEffect, useId, useRef } from "react";
import { m } from "./paraglide/messages.js";

export function useDialogDismiss<T extends HTMLElement>(
  onCancel: () => void,
  options?: { restoreFocus?: (active: Element | null) => boolean },
) {
  const panelRef = useRef<T>(null);
  const onCancelRef = useRef(onCancel);
  const restoreFocusRef = useRef(options?.restoreFocus);
  onCancelRef.current = onCancel;
  restoreFocusRef.current = options?.restoreFocus;
  useEffect(() => {
    const panel = panelRef.current;
    const previously = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      panel
        ? [...panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
            (element) => !element.hasAttribute("disabled"),
          )
        : [];
    focusable()[0]?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const active = document.activeElement;
      if (restoreFocusRef.current?.(active) === false) return;
      previously?.focus();
    };
  }, []);
  return panelRef;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const titleId = useId();
  const busyRef = useRef(busy);
  const startedRef = useRef(false);
  busyRef.current = busy;
  const panelRef = useDialogDismiss<HTMLDivElement>(() => {
    if (!busyRef.current) onCancel();
  });
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (busyRef.current) return;
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div ref={panelRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        <p>{body}</p>
        <div className="row-actions">
          <button
            className="danger"
            type="button"
            disabled={busy}
            onClick={() => {
              if (busyRef.current || startedRef.current) return;
              startedRef.current = true;
              void Promise.resolve(onConfirm()).finally(() => {
                startedRef.current = false;
              });
            }}
          >
            {confirmLabel}
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            {m.action_cancel()}
          </button>
        </div>
      </div>
    </div>
  );
}
