import Link from "next/link";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { LogoIcon } from "@/components/icons";
import { authOptions } from "@/server/auth/auth-options";

// The page depends on the request cookie so an authenticated visitor is never
// served the anonymous landing page from a static cache.
export const dynamic = "force-dynamic";

const highlights = [
  {
    number: "۱",
    title: "صدور سریع فاکتور",
    description: "فاکتورهای حرفه‌ای را در چند قدم بسازید، بررسی کنید و برای مشتری ارسال کنید.",
  },
  {
    number: "۲",
    title: "مدیریت منظم کسب‌وکار",
    description: "مشتریان، کالاها و خدمات خود را در یک فضای ساده و یکپارچه نگه دارید.",
  },
  {
    number: "۳",
    title: "تصمیم‌گیری با دید روشن",
    description: "وضعیت فاکتورها و روند مالی کسب‌وکارتان را همیشه در دسترس داشته باشید.",
  },
];

export default async function HomePage() {
  const session = await getServerSession(authOptions);

  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <main className="min-h-screen overflow-hidden bg-slate-50 text-slate-900" dir="rtl">
      <div className="relative isolate">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[32rem] bg-gradient-to-b from-blue-50 via-slate-50 to-transparent"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -right-24 top-20 -z-10 h-64 w-64 rounded-full bg-blue-200/40 blur-3xl"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -left-24 top-52 -z-10 h-64 w-64 rounded-full bg-sky-100/70 blur-3xl"
          aria-hidden="true"
        />

        <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8 sm:py-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            aria-label="سامانه فاکتور؛ صفحه اصلی"
          >
            <LogoIcon size={34} />
            <span className="text-sm font-bold tracking-tight text-slate-900 sm:text-base">سامانه فاکتور</span>
          </Link>

          <Link
            href="/login"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            ورود به حساب
          </Link>
        </header>

        <section className="mx-auto flex max-w-4xl flex-col items-center px-5 pb-20 pt-16 text-center sm:px-8 sm:pb-28 sm:pt-24">
          <p className="mb-5 inline-flex items-center rounded-full border border-blue-100 bg-white/90 px-3 py-1.5 text-xs font-semibold text-blue-700 shadow-sm">
            مدیریت ساده‌تر فاکتور و امور مالی کسب‌وکار
          </p>
          <h1 className="max-w-3xl text-3xl font-extrabold leading-[1.45] tracking-tight text-slate-950 sm:text-5xl sm:leading-[1.4]">
            از صدور فاکتور تا پیگیری پرداخت‌ها، همه‌چیز در یک‌جا
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-8 text-slate-600 sm:text-lg">
            سامانه فاکتور به شما کمک می‌کند امور مالی روزانهٔ کسب‌وکارتان را سریع، شفاف و حرفه‌ای مدیریت کنید.
          </p>

          <div className="mt-9 flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
            <Link
              href="/login"
              className="inline-flex h-12 items-center justify-center rounded-lg bg-blue-600 px-6 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              شروع رایگان با گوگل
            </Link>
            <a
              href="#features"
              className="inline-flex h-12 items-center justify-center rounded-lg border border-slate-300 bg-white px-6 text-sm font-bold text-slate-700 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              آشنایی با امکانات
            </a>
          </div>

          <p className="mt-5 text-xs leading-6 text-slate-500">بدون نیاز به نصب نرم‌افزار؛ در هر زمان و از هر دستگاه.</p>
        </section>
      </div>

      <section id="features" className="border-y border-slate-200 bg-white" aria-labelledby="features-title">
        <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 id="features-title" className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              ابزارهای ضروری، بدون پیچیدگی
            </h2>
            <p className="mt-3 text-sm leading-7 text-slate-600 sm:text-base">
              روی مدیریت کسب‌وکارتان تمرکز کنید؛ سامانه فاکتور نظم و پیگیری امور مالی را ساده می‌کند.
            </p>
          </div>

          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {highlights.map((highlight) => (
              <article key={highlight.title} className="rounded-xl border border-slate-200 bg-slate-50/70 p-6 text-right">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 text-sm font-bold text-blue-700">
                  {highlight.number}
                </span>
                <h3 className="mt-5 text-base font-bold text-slate-900">{highlight.title}</h3>
                <p className="mt-2 text-sm leading-7 text-slate-600">{highlight.description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <footer className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-5 py-7 text-center text-xs text-slate-500 sm:flex-row sm:px-8 sm:text-right">
        <p>سامانه فاکتور؛ همراه کسب‌وکار شما برای مدیریت مالی بهتر</p>
        <Link href="/login" className="font-semibold text-blue-700 transition-colors hover:text-blue-800 hover:underline">
          ورود و شروع کار
        </Link>
      </footer>
    </main>
  );
}
