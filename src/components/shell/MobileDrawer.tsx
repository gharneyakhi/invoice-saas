"use client";

import * as React from "react";
import clsx from "clsx";
import { Sidebar } from "./Sidebar";
import { XIcon } from "@/components/icons";
import type { DashboardAccountDTO, DashboardPlanDTO } from "@/server/dashboard/dashboardService";

export interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  account: DashboardAccountDTO;
  plan: DashboardPlanDTO;
}

export function MobileDrawer({
  isOpen,
  onClose,
  account,
  plan,
}: MobileDrawerProps) {
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    if (isOpen) {
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", handleKeyDown);
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-gray-900/40 backdrop-blur-xs transition-opacity duration-300 animate-in fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer Panel */}
      <div className="fixed inset-y-0 right-0 w-72 max-w-[85vw] bg-white shadow-2xl z-10 flex flex-col transition-transform duration-300 animate-in slide-in-from-right">
        <div className="absolute top-4 left-4 z-20">
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن منو"
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition"
          >
            <XIcon size={20} />
          </button>
        </div>

        <Sidebar
          account={account}
          plan={plan}
          onLinkClick={onClose}
          className="w-full border-l-0"
        />
      </div>
    </div>
  );
}
