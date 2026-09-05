import { redirect } from "next/navigation";
import { requireSession, UnauthorizedError, ForbiddenError } from "@/server/auth/requireSession";
import { prisma } from "@/lib/prisma";
import { SignOutButton } from "./SignOutButton";

export default async function DashboardPage() {
  let ctx;
  try {
    ctx = await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      redirect("/login");
    }
    throw err;
  }

  // Demonstrates that the Phase-2 bootstrap actually produced a usable
  // Account -> Business chain; later phases will replace this with the
  // real dashboard (usage card, recent invoices, etc.).
  const account = await prisma.account.findUnique({
    where: { id: ctx.accountId },
    include: { businesses: true, subscriptions: { include: { plan: true } } },
  });

  return (
    <main className="mx-auto max-w-2xl p-8" dir="rtl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-bold text-gray-900">داشبورد</h1>
        <SignOutButton />
      </div>
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-gray-500">حساب: {account?.name}</p>
        <p className="text-sm text-gray-500">
          پلن فعلی: {account?.subscriptions[0]?.plan.name ?? "—"}
        </p>
        <p className="mt-4 text-sm font-medium text-gray-700">کسب‌وکارها:</p>
        <ul className="mt-2 space-y-1">
          {account?.businesses.map((b) => (
            <li key={b.id} className="text-sm text-gray-600">
              {b.name} {b.isPrimary ? "(اصلی)" : ""}
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
