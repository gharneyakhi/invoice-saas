import type { Metadata } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "سامانه فاکتور",
  description: "پلتفرم صدور و مدیریت فاکتور کسب‌وکار",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
