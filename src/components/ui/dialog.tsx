"use client";

import * as React from "react";
import clsx from "clsx";

/**
 * Shared modal dialog shell for the UI kit.
 *
 * One accessible overlay/panel implementation (Escape-to-close, backdrop
 * click, initial focus, body scroll lock) so individual dialogs only own
 * their content and confirm logic. Existing dialogs (e.g. the business
 * archive confirmation) keep their own inline copies untouched; new
 * dialogs should build on this instead of re-implementing the pattern.
 */
export interface DialogProps {
  /** `id` of the element labelling the dialog (usually its title). */
  labelledBy: string;
  /** `id` of the element describing the dialog (optional). */
  describedBy?: string;
  /** Called on Escape, backdrop click, or an explicit cancel control. */
  onClose: () => void;
  /** Whether clicking the backdrop closes the dialog (default true). */
  closeOnBackdrop?: boolean;
  /** Panel width/positioning overrides. */
  className?: string;
  children: React.ReactNode;
}

export function Dialog({
  labelledBy,
  describedBy,
  onClose,
  closeOnBackdrop = true,
  className,
  children,
}: DialogProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  // The close handler is read through a ref so re-renders (e.g. while the
  // user types in a form dialog) never re-subscribe listeners or steal
  // focus back to the panel.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    panelRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50 p-4"
      role="presentation"
      onClick={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={clsx(
          "max-h-[90vh] w-full overflow-y-auto rounded-xl border border-gray-200 bg-white p-5 shadow-xl focus:outline-none",
          className ?? "max-w-md",
        )}
      >
        {children}
      </div>
    </div>
  );
}
