import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { X } from "lucide-react";

export function Modal(props: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  width?: "medium" | "large";
}): JSX.Element | null {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(props.onClose);
  const titleId = useId();
  onCloseRef.current = props.onClose;

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    if (!element) {
      return;
    }
    if (!element.open) {
      element.showModal();
    }
    const frame = requestAnimationFrame(() => {
      const initialFocus = element.querySelector<HTMLElement>(
        [
          "[autofocus]",
          "input:not([disabled])",
          "select:not([disabled])",
          "textarea:not([disabled])",
          "button:not([disabled]):not([data-modal-close])",
        ].join(","),
      );
      (initialFocus ?? closeButton.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (element.open) {
        element.close();
      }
      if (previous?.isConnected) {
        previous.focus();
      }
    };
  }, [props.open]);

  if (!props.open) {
    return null;
  }

  const closeFromBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    const bounds = dialog.current
      ?.querySelector<HTMLElement>(".modal-window")
      ?.getBoundingClientRect();
    if (
      bounds &&
      (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
    ) {
      onCloseRef.current();
    }
  };

  const trapFocus = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Tab") {
      return;
    }
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
      [
        "button:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        "summary",
        "[href]",
        "[tabindex]:not([tabindex='-1'])",
      ].join(","),
    )].filter((element) => !element.hasAttribute("hidden"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      closeButton.current?.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialog}
      className="modal-backdrop"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCloseRef.current();
      }}
      onMouseDown={closeFromBackdrop}
      onKeyDown={trapFocus}
    >
      <section
        className={`modal-window modal-window--${props.width ?? "medium"}`}
      >
        <header className="modal-header">
          <h2 id={titleId}>{props.title}</h2>
          <button
            ref={closeButton}
            data-modal-close
            className="icon-button"
            type="button"
            onClick={() => onCloseRef.current()}
            aria-label="Close"
            title="Close"
          >
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
      </section>
    </dialog>
  );
}
