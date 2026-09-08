"use client";

import * as React from "react";
import clsx from "clsx";

/**
 * Shared labelled-field wrapper for the UI kit: Persian label, required
 * marker, inline validation message (role="alert") or hint. Same contract as
 * the invoice editor's `InvoiceField`, promoted to the kit for every other
 * form; the invoice-scoped original stays untouched.
 */
export interface FieldProps {
  /** Persian field label. */
  label: string;
  /** `id` of the wrapped control, for the label's htmlFor. */
  htmlFor?: string;
  /** Persian, field-level validation message. Rendered in place of `hint`. */
  error?: string;
  /** Subtle helper text shown while there is no error. */
  hint?: string;
  /** Appends a required marker to the label. */
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  required = false,
  className,
  children,
}: FieldProps) {
  const descriptionId = React.useId();

  return (
    <div className={clsx("space-y-1.5 min-w-0", className)}>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-gray-700">
        {label}
        {required && (
          <>
            {" "}
            <span className="text-rose-500" aria-hidden="true">
              *
            </span>
          </>
        )}
      </label>
      {children}
      {error ? (
        <p id={descriptionId} className="text-[11px] leading-relaxed text-rose-600" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={descriptionId} className="text-[11px] leading-relaxed text-gray-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
