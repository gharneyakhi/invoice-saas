import { redirect } from "next/navigation";
import { requireSession, UnauthorizedError, ForbiddenError } from "@/server/auth/requireSession";
import { getDashboardData } from "@/server/dashboard/dashboardService";
import { AppShell } from "@/components/shell/AppShell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let data;
  try {
    data = await getDashboardData();
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      redirect("/login");
    }
    throw err;
  }

  return (
    <AppShell
      account={data.account}
      currentBusiness={data.currentBusiness}
      businesses={data.businesses}
      plan={data.plan}
    >
      {children}
    </AppShell>
  );
}
