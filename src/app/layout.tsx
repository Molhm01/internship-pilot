import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { ToastHost } from "@/components/ui/Toast";
import { ThemeSync } from "@/components/ui/ThemeSync";
import { resolveAppUrl } from "@/lib/runtime/appUrl";

const metadataBase = new URL(resolveAppUrl() ?? "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase,
  title: {
    default: "Internship Pilot — Autonomous Internship Discovery & Application Platform",
    template: "%s — Internship Pilot",
  },
  description:
    "Discover live engineering internships posted within days, get instant 100% ATS fit scores, generate tailored documents, and submit applications autonomously.",
  applicationName: "Internship Pilot",
  keywords: [
    "internships",
    "engineering internships",
    "electrical engineering",
    "computer engineering",
    "autonomous application agent",
    "resume tailoring",
  ],
  openGraph: {
    title: "Internship Pilot",
    description:
      "Discover live engineering internships, score 100% of postings instantly, tailor clean PDFs, and run autonomous submissions.",
    type: "website",
    siteName: "Internship Pilot",
  },
  twitter: {
    card: "summary_large_image",
    title: "Internship Pilot",
    description:
      "Autonomous internship discovery, instant ATS scoring, and hands-free application execution.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F8FAFC" },
    { media: "(prefers-color-scheme: dark)", color: "#0B1120" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="light"
      className={`h-full ${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-full bg-canvas text-primary antialiased">
        <ThemeSync />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-100 focus:rounded-md focus:border focus:border-accent-line focus:bg-overlay focus:px-3 focus:py-2 focus:text-small focus:text-primary"
        >
          Skip to content
        </a>
        {children}
        <ToastHost />
      </body>
    </html>
  );
}
