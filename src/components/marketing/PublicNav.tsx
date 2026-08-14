"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X, ArrowRight } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Wordmark } from "@/components/shell/Wordmark";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

const LINKS = [
  { href: "#product", label: "Product" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#agent", label: "AI Agent" },
  { href: "#architecture", label: "Architecture" },
  { href: "#status", label: "Status" },
];

/**
 * Public navigation.
 *
 * Transparent over the hero, then bordered and blurred once scrolled — the
 * transition is what tells the reader the hero has ended. Active section is
 * tracked with IntersectionObserver rather than scroll maths so it stays
 * correct at any viewport height.
 */
export function PublicNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 12);
      // While the hero is on screen no section is "current". Without this the
      // observer keeps whatever it matched last, so returning to the top leaves
      // a stale item underlined.
      if (y < 200) setActive("");
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const sections = LINKS.map((link) => document.querySelector(link.href)).filter(
      (element): element is Element => Boolean(element),
    );
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActive(`#${visible.target.id}`);
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: [0, 0.25, 0.5, 1] },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-colors duration-300 ease-standard",
        scrolled
          ? "border-b border-hairline bg-canvas/80 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5 lg:px-8">
        <Link href="/" className="shrink-0 rounded-md" aria-label="Internship Pilot — home">
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label="Sections">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={cn(
                "relative rounded-md px-2.5 py-1.5 text-small transition-colors duration-[120ms] ease-standard",
                active === link.href
                  ? "text-primary"
                  : "text-secondary hover:text-primary",
              )}
            >
              {link.label}
              {active === link.href && (
                <span
                  className="absolute inset-x-2.5 -bottom-px h-px bg-accent"
                  aria-hidden
                />
              )}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle className="hidden sm:inline-flex" />
          <Link
            href="/dashboard"
            className="hidden h-7 items-center rounded-md px-2.5 text-small text-secondary transition-colors duration-[120ms] ease-standard hover:bg-n-150 hover:text-primary sm:inline-flex"
          >
            Sign in
          </Link>
          <Link
            href="/jobs"
            className="group inline-flex h-7 items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 text-small font-medium text-inverse transition-colors duration-[120ms] ease-standard hover:bg-accent-hover"
          >
            Explore internships
            <ArrowRight
              className="size-3.5 transition-transform duration-[180ms] ease-standard group-hover:translate-x-0.5"
              aria-hidden
            />
          </Link>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className="inline-flex size-7 items-center justify-center rounded-md text-tertiary hover:bg-n-150 hover:text-primary lg:hidden"
          >
            {open ? <X className="size-4" aria-hidden /> : <Menu className="size-4" aria-hidden />}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-hairline bg-canvas/95 backdrop-blur-xl lg:hidden">
          <nav className="mx-auto max-w-6xl px-5 py-3" aria-label="Sections">
            <ul className="space-y-0.5">
              {LINKS.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="block rounded-md px-2 py-2 text-small text-secondary hover:bg-n-150 hover:text-primary"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
              <li className="pt-1">
                <Link
                  href="/dashboard"
                  className="block rounded-md px-2 py-2 text-small text-secondary hover:bg-n-150 hover:text-primary"
                >
                  Sign in
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      )}
    </header>
  );
}
