"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen, Menu, X, Search, LogOut } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { NAV_GROUPS, isActive, type NavItem } from "./nav-config";
import { Wordmark } from "./Wordmark";
import { ThemeToggle } from "./ThemeToggle";
import { CommandPalette } from "./CommandPalette";

const COLLAPSE_KEY = "ip-sidebar-collapsed";

/**
 * Authenticated application shell.
 *
 * Three layouts from one nav definition: an expanded sidebar, a collapsed icon
 * rail, and a mobile drawer. The rail is not a separate component — collapsing
 * hides labels and re-centres icons, so the two can never drift apart.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [account, setAccount] = useState<
    { user: { email: string } | null; singleUserMode: boolean } | undefined
  >(undefined);

  // Restored after mount rather than read during render, so the server and the
  // first client paint agree on the expanded layout.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* storage unavailable — expanded is a fine default */
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  /**
   * Three states, not two: not asked yet, signed in, and "this deployment has
   * no accounts at all". The third is why `singleUserMode` is read rather than
   * inferred from a null user — otherwise local mode would permanently offer a
   * "Log in" link to a page that does not exist.
   */
  useEffect(() => {
    void fetch("/api/auth/me")
      .then((response) => (response.ok ? response.json() : { user: null, singleUserMode: true }))
      .then((data: { user: { email: string } | null; singleUserMode?: boolean }) =>
        setAccount({ user: data.user, singleUserMode: data.singleUserMode !== false }),
      )
      .catch(() => setAccount({ user: null, singleUserMode: true }));
  }, [pathname]);

  // Close the mobile drawer on navigation, or it covers the page just opened.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") setMobileOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-screen">
      {/* ------------------------------------------------ desktop sidebar */}
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-hairline bg-surface md:flex",
          "transition-[width] duration-200 ease-standard",
          collapsed ? "w-[3.25rem]" : "w-[13.5rem]",
        )}
      >
        <div
          className={cn(
            "flex h-12 shrink-0 items-center border-b border-hairline",
            collapsed ? "justify-center px-0" : "px-3",
          )}
        >
          <Link href="/dashboard" className="rounded-md" aria-label="Internship Pilot">
            <Wordmark compact={collapsed} />
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3" aria-label="Main">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-4 last:mb-0">
              {!collapsed && (
                <p className="px-2 pb-1.5 text-micro font-medium uppercase tracking-[0.075em] text-faint">
                  {group.label}
                </p>
              )}
              {collapsed && <div className="mx-2 mb-2 border-t border-hairline first:border-0" />}
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <NavLink item={item} pathname={pathname} collapsed={collapsed} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-hairline p-2">
          {account && !account.singleUserMode && account.user && (
            <div className={cn("mb-1.5", collapsed ? "hidden" : "px-2")}>
              <p className="truncate text-micro text-faint" title={account.user.email}>
                {account.user.email}
              </p>
            </div>
          )}
          <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
            <ThemeToggle />
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="inline-flex size-7 items-center justify-center rounded-md text-tertiary transition-colors duration-[120ms] ease-standard hover:bg-n-200 hover:text-primary"
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" aria-hidden />
              ) : (
                <PanelLeftClose className="size-4" aria-hidden />
              )}
            </button>
            {account && !account.singleUserMode && account.user && !collapsed && (
              <Link
                href="/logout"
                aria-label="Log out"
                title="Log out"
                className="ml-auto inline-flex size-7 items-center justify-center rounded-md text-tertiary transition-colors duration-[120ms] ease-standard hover:bg-n-200 hover:text-primary"
              >
                <LogOut className="size-4" aria-hidden />
              </Link>
            )}
          </div>
        </div>
      </aside>

      {/* -------------------------------------------------- mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-n-0/70 backdrop-blur-[2px]"
          />
          <div className="absolute inset-y-0 left-0 flex w-[15rem] flex-col border-r border-line bg-surface shadow-overlay">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-hairline px-3">
              <Wordmark />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation"
                className="inline-flex size-7 items-center justify-center rounded-md text-tertiary hover:bg-n-200 hover:text-primary"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Main">
              {NAV_GROUPS.map((group) => (
                <div key={group.label} className="mb-4 last:mb-0">
                  <p className="px-2 pb-1.5 text-micro font-medium uppercase tracking-[0.075em] text-faint">
                    {group.label}
                  </p>
                  <ul className="space-y-0.5">
                    {group.items.map((item) => (
                      <li key={item.href}>
                        <NavLink item={item} pathname={pathname} collapsed={false} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-hairline bg-canvas/85 px-3 backdrop-blur-md md:px-4">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            className="inline-flex size-7 items-center justify-center rounded-md text-tertiary hover:bg-n-200 hover:text-primary md:hidden"
          >
            <Menu className="size-4" aria-hidden />
          </button>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className={cn(
              "group flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-surface px-2",
              "text-left text-small text-faint transition-colors duration-[120ms] ease-standard",
              "hover:border-line-strong hover:text-tertiary md:max-w-xs",
            )}
          >
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">Search or jump to…</span>
            <kbd className="ml-auto hidden shrink-0 rounded-xs border border-line px-1 font-mono text-micro text-faint sm:block">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-1 md:hidden">
            <ThemeToggle />
          </div>
        </header>

        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

function NavLink({
  item,
  pathname,
  collapsed,
}: {
  item: NavItem;
  pathname: string | null;
  collapsed: boolean;
}) {
  const active = isActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        "relative flex h-7 items-center gap-2.5 rounded-md text-small transition-colors duration-[120ms] ease-standard",
        collapsed ? "justify-center px-0" : "px-2",
        active
          ? "bg-accent-quiet text-primary"
          : "text-secondary hover:bg-n-150 hover:text-primary",
      )}
    >
      {/* The active marker is a rule, not a filled pill — it reads as an
          instrument indicator and survives the collapsed rail unchanged. */}
      {active && (
        <span
          className="absolute left-0 top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-full bg-accent"
          aria-hidden
        />
      )}
      <Icon
        className={cn("size-4 shrink-0", active ? "text-accent" : "text-tertiary")}
        aria-hidden
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}
