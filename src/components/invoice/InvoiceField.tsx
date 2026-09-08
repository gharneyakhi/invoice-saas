"use client";

import * as React from "react";
import clsx from "clsx";

/**
 * Input primitives for the invoice editor, styled after the Dashboard V1
 * design system (`Button` focus ring, `Card` border/radius). The core UI kit
 * has no Input component yet — these stay invoice-scoped so a future shared
 * kit can adopt them untouched.
 */
export function invoiceInputClassName(hasError?: boolean): string {
  return clsx(
    "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 transition-colors",
    "placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-offset-1",
    "disabled:cursor-not-allowed disabled:opacity-50",
    hasError
      ? "border-rose-400 focus:border-rose-500 focus:ring-rose-500"
      : "border-gray-300 hover:border-gray-400 focus:border-blue-600 focus:ring-blue-600",
  );
}

export interface InvoiceFieldProps {
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

export function InvoiceField({
  label,
  htmlFor,
  error,
  hint,
  required = false,
  className,
  children,
}: InvoiceFieldProps) {
  const descriptionId = React.useId();

  return (
    <div className={clsx("space-y-1.5", className)}>
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
