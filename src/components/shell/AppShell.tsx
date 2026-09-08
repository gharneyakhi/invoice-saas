"use client";

import * as React from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { MobileDrawer } from "./MobileDrawer";
import type {
  DashboardAccountDTO,
  DashboardPlanDTO,
  BusinessDTO,
} from "@/server/dashboard/dashboardService";

export interface AppShellProps {
  account: DashboardAccountDTO;
  currentBusiness: BusinessDTO | null;
  businesses: BusinessDTO[];
  plan: DashboardPlanDTO;
  children: React.ReactNode;
}

export function AppShell({
  account,
  currentBusiness,
  businesses,
  plan,
  children,
}: AppShellProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex print:bg-white" dir="rtl">
      {/* Desktop Sidebar (Right side in RTL) — never printed */}
      <div className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 lg:right-0 z-40 print:hidden">
        <Sidebar account={account} plan={plan} />
      </div>

      {/* Mobile / Tablet Drawer — never printed */}
      <div className="print:hidden">
        <MobileDrawer
          isOpen={mobileMenuOpen}
          onClose={() => setMobileMenuOpen(false)}
          account={account}
          plan={plan}
        />
      </div>

      {/* Main Content Area */}
      <div className="flex-1 lg:pr-64 flex flex-col min-h-screen min-w-0 print:pr-0 print:min-h-0">
        <div className="print:hidden">
          <Header
            account={account}
            currentBusiness={currentBusiness}
            businesses={businesses}
            plan={plan}
            onOpenMobileMenu={() => setMobileMenuOpen(true)}
          />
        </div>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto print:p-0 print:max-w-none print:flex-none">
          {children}
        </main>
      </div>
    </div>
  );
}
