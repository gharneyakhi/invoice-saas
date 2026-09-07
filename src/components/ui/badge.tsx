import * as React from "react";
import clsx from "clsx";
import type { StatusBadgeVariant } from "@/lib/formatters";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: StatusBadgeVariant | "outline";
  showDot?: boolean;
}

export function Badge({
  className,
  variant = "default",
  showDot = false,
  children,
  ...props
}: BadgeProps) {
  const variantStyles = {
    default: "bg-blue-50 text-blue-700 border-blue-200",
    secondary: "bg-gray-100 text-gray-700 border-gray-200",
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warning: "bg-amber-50 text-amber-800 border-amber-200",
    danger: "bg-rose-50 text-rose-700 border-rose-200",
    info: "bg-sky-50 text-sky-700 border-sky-200",
    draft: "bg-slate-100 text-slate-700 border-slate-200",
    outline: "bg-transparent text-gray-700 border-gray-300",
  };

  const dotStyles = {
    default: "bg-blue-500",
    secondary: "bg-gray-400",
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    danger: "bg-rose-500",
    info: "bg-sky-500",
    draft: "bg-slate-400",
    outline: "bg-gray-400",
  };

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border transition-colors",
        variantStyles[variant],
        className,
      )}
      {...props}
    >
      {showDot && (
        <span
          className={clsx("w-1.5 h-1.5 rounded-full shrink-0", dotStyles[variant])}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
