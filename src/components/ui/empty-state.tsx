import * as React from "react";
import clsx from "clsx";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center justify-center p-8 text-center rounded-xl border border-dashed border-gray-200 bg-gray-50/50",
        className,
      )}
    >
      {icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white border border-gray-200 text-gray-500 shadow-sm mb-4">
          {icon}
        </div>
      )}
      <h4 className="text-sm font-semibold text-gray-900 mb-1">{title}</h4>
      {description && (
        <p className="text-xs text-gray-500 max-w-sm mb-5 leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
