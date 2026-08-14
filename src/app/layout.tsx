import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { ToastHost } from "@/components/ui/Toast";

export const metadata: Metadata = {
  metadataBase: new URL("http://localhost:3000"),
  title: {
    default: "Internship Pilot — From internship search to application, one intelligent system",
    template: "%s — Internship Pilot",
  },
  description:
    "Discover engineering internships, understand your fit, tailor your materials, and let an AI Agent handle repetitive application work while you remain in control. Runs locally on your own machine.",
  applicationName: "Internship Pilot",
  keywords: [
    "internships",
    "engineering internships",
    "electrical engineering",
    "computer engineering",
    "application agent",
    "resume tailoring",
    "local AI",
  ],
  openGraph: {
    title: "Internship Pilot",
    description:
      "Discover engineering internships, understand your fit, tailor your materials, and let an AI Agent handle repetitive application work while you remain in control.",
    type: "website",
    siteName: "Internship Pilot",
  },
  twitter: {
    card: "summary_large_image",
    title: "Internship Pilot",
    description:
      "From internship search to application, one intelligent system. An application Agent that verifies its own work.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0c0f" },
    { media: "(prefers-color-scheme: light)", color: "#fbfbfc" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * Applies the stored theme before first paint.
 *
 * Without this the page renders dark, then snaps to light for users who chose
 * light — a flash on every navigation. It is deliberately tiny, synchronous and
 * inlined; anything async is too late to matter.
 */
const THEME_BOOTSTRAP = `
(function(){try{
var t=localStorage.getItem("ip-theme");
if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}
}catch(e){}})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`h-full ${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-full bg-canvas text-primary antialiased">
        {/* Section 66: skip-to-content must be the first focusable element. */}
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
