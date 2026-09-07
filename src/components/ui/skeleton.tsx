import * as React from "react";
import clsx from "clsx";

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx(
        "animate-pulse rounded-md bg-gray-200/80",
        className,
      )}
      aria-hidden="true"
      {...props}
    />
  );
}
