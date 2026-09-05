import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/server/auth/auth-options";
import { SignInButton } from "./SignInButton";

export default async function LoginPage() {
  const session = await getServerSession(authOptions);
  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50" dir="rtl">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <h1 className="mb-2 text-xl font-bold text-gray-900">ورود به سامانه فاکتور</h1>
        <p className="mb-6 text-sm text-gray-500">
          برای ورود یا ثبت‌نام، از حساب Google خود استفاده کنید.
        </p>
        <SignInButton />
        <p className="mt-6 text-xs text-gray-400">
          با ورود، شرایط استفاده و حریم خصوصی را می‌پذیرید.
        </p>
      </div>
    </main>
  );
}
