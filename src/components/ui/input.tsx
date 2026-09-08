"use client";

import * as React from "react";
import clsx from "clsx";

/**
 * Shared form-control primitives for the UI kit, styled after the Dashboard V1
 * design system (same border/radius/focus-ring language as `Button`, `Card`
 * and the invoice editor's inputs). The invoice editor keeps its own
 * invoice-scoped copies untouched (see `components/invoice/InvoiceField`);
 * these are the kit-level equivalents for every other form.
 */

export function inputClassName(hasError?: boolean): string {
  return clsx(
    "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 transition-colors",
    "placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-offset-1",
    "disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-gray-50",
    hasError
      ? "border-rose-400 focus:border-rose-500 focus:ring-rose-500"
      : "border-gray-300 hover:border-gray-400 focus:border-blue-600 focus:ring-blue-600",
  );
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { hasError?: boolean }
>(function Input({ className, hasError, ...props }, ref) {
  return <input ref={ref} className={clsx(inputClassName(hasError), className)} {...props} />;
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { hasError?: boolean }
>(function Textarea({ className, hasError, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={clsx(inputClassName(hasError), "min-h-[84px] resize-y leading-relaxed", className)}
      {...props}
    />
  );
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & { hasError?: boolean }
>(function Select({ className, hasError, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={clsx(inputClassName(hasError), "appearance-none bg-white", className)}
      {...props}
    >
      {children}
    </select>
  );
});
