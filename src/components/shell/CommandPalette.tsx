"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import {
  Compass,
  UserRound,
  Bot,
  Layers,
  FileText,
  Stethoscope,
  SunMoon,
  Search,
  CornerDownLeft,
} from "lucide-react";
import { applyTheme, readTheme } from "./ThemeToggle";
import { NAV_GROUPS } from "./nav-config";

type Action = {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
  keywords?: string;
};

/**
 * Command palette (⌘K / Ctrl+K).
 *
 * Navigation entries are derived from NAV_GROUPS rather than duplicated, so a
 * route added to the sidebar is reachable from the palette automatically.
 * Commands that do something (rather than go somewhere) are listed separately
 * because mixing them makes both harder to scan.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  function go(href: string) {
    onOpenChange(false);
    router.push(href);
  }

  const commands: Action[] = [
    {
      id: "theme",
      label: "Toggle theme",
      hint: "Switch between dark and light",
      icon: SunMoon,
      keywords: "dark light appearance",
      run: () => {
        applyTheme(readTheme() === "dark" ? "light" : "dark");
        onOpenChange(false);
      },
    },
    {
      id: "discover",
      label: "Search internships",
      icon: Compass,
      keywords: "jobs discover find",
      run: () => go("/jobs"),
    },
    {
      id: "agent",
      label: "Open Agent",
      icon: Bot,
      keywords: "autofill run application",
      run: () => go("/agent"),
    },
    {
      id: "applications",
      label: "Open applications",
      icon: Layers,
      keywords: "tracker kanban status",
      run: () => go("/tracker"),
    },
    {
      id: "documents",
      label: "Open documents",
      icon: FileText,
      keywords: "resume cover letter pdf",
      run: () => go("/documents"),
    },
    {
      id: "profile",
      label: "Open profile",
      icon: UserRound,
      keywords: "candidate education experience",
      run: () => go("/profile"),
    },
    {
      id: "diagnostics",
      label: "Open diagnostics",
      icon: Stethoscope,
      keywords: "debug trace ollama connection",
      run: () => go("/agent-diagnostics"),
    },
  ];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-100 flex items-start justify-center pt-[12vh]">
      <button
        type="button"
        aria-label="Close command palette"
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 bg-n-0/70 backdrop-blur-[3px]"
      />
      <Command
        label="Command palette"
        loop
        className="relative z-10 w-[min(36rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-overlay shadow-overlay"
      >
        <div className="flex items-center gap-2 border-b border-hairline px-3">
          <Search className="size-4 shrink-0 text-faint" aria-hidden />
          <Command.Input
            value={search}
            onValueChange={setSearch}
            autoFocus
            placeholder="Search or jump to…"
            className="h-11 flex-1 bg-transparent text-body text-primary outline-none placeholder:text-faint"
          />
          <kbd className="hidden shrink-0 rounded-xs border border-line px-1 font-mono text-micro text-faint sm:block">
            esc
          </kbd>
        </div>

        <Command.List className="max-h-[22rem] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-8 text-center text-small text-tertiary">
            No matches.
          </Command.Empty>

          <Command.Group
            heading="Commands"
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.075em] [&_[cmdk-group-heading]]:text-faint"
          >
            {commands.map((action) => (
              <PaletteItem key={action.id} action={action} />
            ))}
          </Command.Group>

          {NAV_GROUPS.map((group) => (
            <Command.Group
              key={group.label}
              heading={group.label}
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.075em] [&_[cmdk-group-heading]]:text-faint"
            >
              {group.items.map((item) => (
                <PaletteItem
                  key={item.href}
                  action={{
                    id: item.href,
                    label: item.label,
                    icon: item.icon,
                    hint: item.href,
                    run: () => go(item.href),
                  }}
                />
              ))}
            </Command.Group>
          ))}
        </Command.List>

        <div className="flex items-center gap-3 border-t border-hairline px-3 py-1.5 text-micro text-faint">
          <span className="flex items-center gap-1">
            <CornerDownLeft className="size-3" aria-hidden /> to select
          </span>
          <span>↑↓ to navigate</span>
        </div>
      </Command>
    </div>
  );
}

function PaletteItem({ action }: { action: Action }) {
  const Icon = action.icon;
  return (
    <Command.Item
      value={`${action.label} ${action.keywords ?? ""}`}
      onSelect={action.run}
      className="flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-small text-secondary data-[selected=true]:bg-accent-quiet data-[selected=true]:text-primary"
    >
      <Icon className="size-4 shrink-0 text-tertiary" />
      <span className="truncate">{action.label}</span>
      {action.hint && (
        <span className="ml-auto truncate font-mono text-micro text-faint">{action.hint}</span>
      )}
    </Command.Item>
  );
}
