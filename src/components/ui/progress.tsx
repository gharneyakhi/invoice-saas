import * as React from "react";
import clsx from "clsx";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number; // 0 to 100
  variant?: "default" | "success" | "warning" | "danger";
}

export function Progress({
  value = 0,
  variant = "default",
  className,
  ...props
}: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));

  const colorStyles = {
    default: "bg-blue-600",
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    danger: "bg-rose-500",
  };

  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={clsx(
        "relative h-2 w-full overflow-hidden rounded-full bg-gray-100",
        className,
      )}
      {...props}
    >
      <div
        className={clsx(
          "h-full transition-all duration-300 ease-in-out rounded-full",
          colorStyles[variant],
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
