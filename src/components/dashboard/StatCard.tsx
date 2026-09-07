import * as React from "react";
import clsx from "clsx";
import { Card, CardContent } from "@/components/ui/card";

export interface StatCardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ReactNode;
  iconBgColor?: string;
  iconTextColor?: string;
  badge?: React.ReactNode;
  className?: string;
}

export function StatCard({
  title,
  value,
  subtitle,
  icon,
  iconBgColor = "bg-blue-50",
  iconTextColor = "text-blue-600",
  badge,
  className,
}: StatCardProps) {
  return (
    <Card className={clsx("overflow-hidden hover:border-gray-300 transition-colors", className)}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2 flex-1 min-w-0">
            <p className="text-xs font-medium text-gray-500 truncate">{title}</p>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900 font-sans">
                {value}
              </span>
              {badge}
            </div>
            {subtitle && (
              <p className="text-[11px] text-gray-400 truncate leading-relaxed">
                {subtitle}
              </p>
            )}
          </div>
          <div
            className={clsx(
              "flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-xl",
              iconBgColor,
              iconTextColor,
            )}
            aria-hidden="true"
          >
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
