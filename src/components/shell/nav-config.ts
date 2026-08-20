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
  ClipboardCheck,
  MapPin,
  Settings,
  Stethoscope,
  Palette,
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

/**
 * Authenticated navigation.
 *
 * Grouped by what the user is doing rather than by which subsystem owns the
 * route. The resume is the primary candidate input; the larger application
 * autofill profile remains an optional child route reached from /profile.
 */
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
    label: "Agent",
    items: [
      { href: "/agent", label: "Agent", icon: Bot, badgeKey: "pendingQuestions" },
      { href: "/activity", label: "Activity", icon: Activity },
      { href: "/agent-diagnostics", label: "Diagnostics", icon: Stethoscope },
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
    label: "Review",
    items: [
      { href: "/assessments", label: "Assessments", icon: ClipboardCheck },
      { href: "/security-quarantine", label: "Quarantine", icon: ShieldCheck },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/design-system", label: "Design system", icon: Palette },
    ],
  },
];

export function isActive(pathname: string | null, item: NavItem): boolean {
  if (!pathname) return false;
  return item.prefix ? pathname.startsWith(item.href) : pathname === item.href;
}
