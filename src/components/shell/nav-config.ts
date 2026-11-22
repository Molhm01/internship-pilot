import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Compass,
  Layers,
  FileText,
  UserRound,
  Bot,
  Activity,
  Building2,
  ShieldCheck,
  MapPin,
  Settings,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Matches child routes too — /jobs highlights on /jobs/[id]. */
  prefix?: boolean;
  /** Renders a count chip. Wired to live data by the shell. */
  badgeKey?: "pendingQuestions" | "needsReview";
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/jobs", label: "Discover", icon: Compass, prefix: true },
      { href: "/tracker", label: "Applications", icon: Layers },
      { href: "/documents", label: "Documents", icon: FileText },
      { href: "/profile", label: "Resume", icon: UserRound, prefix: true },
    ],
  },
  {
    label: "Autonomous Agent",
    items: [
      { href: "/agent", label: "Auto-Pilot", icon: Bot },
      { href: "/activity", label: "Activity", icon: Activity },
    ],
  },
  {
    label: "Sources",
    items: [
      { href: "/watchlist", label: "Watchlist", icon: Building2 },
      { href: "/approved-employers", label: "Approved employers", icon: ShieldCheck },
      { href: "/nearby", label: "Local firms", icon: MapPin },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function isActive(pathname: string | null, item: NavItem): boolean {
  if (!pathname) return false;
  return item.prefix ? pathname.startsWith(item.href) : pathname === item.href;
}
