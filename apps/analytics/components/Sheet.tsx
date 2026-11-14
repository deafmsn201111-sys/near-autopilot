'use client';
import { useId, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';

const EXIT_MS = 150;
const DISMISS_DRAG_PX = 100;

export interface SheetControl {
  readonly ref: RefObject<HTMLDialogElement | null>;
  readonly isOpen: boolean;
  readonly show: () => void;
  /** Plays the exit, then closes; the sheet's `onClosed` runs once it is gone. */
  readonly close: () => void;
}

interface SheetState extends SheetControl {
  readonly entered: boolean;
  readonly closing: boolean;
  readonly setEntered: (v: boolean) => void;
  readonly settle: () => void;
}

export function useSheet(): SheetState {
  const ref = useRef<HTMLDialogElement>(null);
  const [isOpen, setOpen] = useState(false);
  const [entered, setEntered] = useState(false);
  const [closing, setClosing] = useState(false);
  return {
    ref,
    isOpen,
    entered,
    closing,
    setEntered,
    show: () => {
      setOpen(true);
      setEntered(false);
      setClosing(false);
    },
    close: () => {
      if (closing) return;
      setClosing(true);
      setTimeout(() => ref.current?.close(), EXIT_MS);
    },
    settle: () => {
      setOpen(false);
      setClosing(false);
    },
  };
}

const X = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

/**
 * The review-and-sign sheet's shell (DESIGN.md → Review & sign sheet): one 620px column, a bottom sheet that drags to
 * dismiss on phones, a sticky head and footer. `locked` hides Close and ignores Escape and drags (signing in progress).
 */
export function Sheet({
  sheet,
  title,
  context,
  locked = false,
  busy = false,
  onEscape,
  onClosed,
  footer,
  children,
}: {
  sheet: SheetState;
  title: ReactNode;
  context?: ReactNode;
  locked?: boolean;
  busy?: boolean;
  /** Escape inside a sub-view (a token picker): return true when it handled it, so the sheet stays open. */
  onEscape?: () => boolean;
  onClosed?: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const close = () => !locked && sheet.close();

  function mount(el: HTMLDialogElement | null) {
    sheet.ref.current = el;
    if (!el || el.open) return;
    el.showModal();
    document.getElementById(titleId)?.focus({ preventScroll: true });
  }

  function grab(e: PointerEvent<HTMLDivElement>) {
    if (locked) return;
    drag.current = { y: e.clientY, dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || !sheet.ref.current) return;
    d.dy = Math.max(0, e.clientY - d.y);
    sheet.ref.current.style.transform = `translateY(${d.dy}px)`;
  }
  function release() {
    const d = drag.current;
    drag.current = null;
    if (!d || !sheet.ref.current) return;
    sheet.ref.current.style.transform = '';
    if (d.dy > DISMISS_DRAG_PX) close();
  }

  if (!sheet.isOpen) return null;
  return (
    <dialog
      ref={mount}
      className={`sheet${sheet.entered ? ' entered' : ''}${sheet.closing ? ' closing' : ''}`}
      aria-labelledby={titleId}
      aria-busy={busy}
      onAnimationEnd={(e) =>
        e.target === e.currentTarget && !e.pseudoElement && sheet.setEntered(true)
      }
      onCancel={(e) => {
        e.preventDefault();
        if (!onEscape?.()) close();
      }}
      onClose={() => {
        // Signing drops the sheet to non-modal and back (lib/modal.ts): that close is not the user's.
        if (sheet.ref.current?.open) return;
        sheet.settle();
        onClosed?.();
      }}
    >
      <div
        className="grab"
        aria-hidden="true"
        onPointerDown={grab}
        onPointerMove={move}
        onPointerUp={release}
        onPointerCancel={release}
      />
      <header className="sh-head">
        {context && <span className="ctxl">{context}</span>}
        <h2 id={titleId} tabIndex={-1}>
          {title}
        </h2>
        {!locked && (
          <button type="button" className="x" aria-label="Close" onClick={close}>
            {X}
          </button>
        )}
      </header>
      <div className="sh-body">{children}</div>
      {footer && <footer className="sh-foot">{footer}</footer>}
    </dialog>
  );
}
