import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-vazirmatn)", "Tahoma", "sans-serif"],
      },
      colors: {
        brand: {
          DEFAULT: "var(--brand-color, #2563eb)",
        },
      },
    },
  },
  plugins: [],
};
export default config;
