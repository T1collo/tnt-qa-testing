import { DM_Mono, DM_Sans } from "next/font/google";
import "./globals.css";
import { SideNav } from "@/components/side-nav";
import { ThemeProvider } from "@/components/theme-provider";
import { THEME_STORAGE_KEY } from "@/lib/theme";

// DM Sans carries the UI; DM Mono carries test IDs, URLs and response codes - the parts of this
// console that are literally code. Loaded through next/font so the files are self-hosted and
// preloaded, with no render-blocking @import and no layout shift from a late swap.
const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
});

const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata = {
  title: "TnT QA Dashboard",
  description: "Partner EPCIS API test runner, results dashboard, and Excel export for the TnT QA suite",
};

// Runs before first paint so the page never flashes light before React restores a dark
// choice. Mirrors the resolution logic in ThemeProvider - keep the two in step.
const themeScript = `(function(){try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var d=s==="dark"||((s===null||s==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${dmMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">
        <ThemeProvider>
          <SideNav>{children}</SideNav>
        </ThemeProvider>
      </body>
    </html>
  );
}
