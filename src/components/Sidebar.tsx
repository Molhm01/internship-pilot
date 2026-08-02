"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/profile", label: "Profile", icon: ProfileIcon },
  { href: "/jobs", label: "Jobs", icon: JobsIcon },
  { href: "/watchlist", label: "Company Watchlist", icon: WatchlistIcon },
  { href: "/approved-employers", label: "Approved Employers", icon: WatchlistIcon },
  { href: "/nearby", label: "Local Firms", icon: NearbyIcon },
  { href: "/documents", label: "Documents", icon: DocumentsIcon },
  { href: "/agent-diagnostics", label: "Agent Diagnostics", icon: ReviewIcon },
  { href: "/tracker", label: "Tracker", icon: TrackerIcon },
  { href: "/assessments", label: "Assessment Inbox", icon: AssessmentIcon },
  { href: "/security-quarantine", label: "Security Quarantine", icon: SecurityIcon },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 shrink-0 h-screen sticky top-0 flex flex-col bg-[#12211f] text-slate-100">
      <div className="px-5 py-6 border-b border-white/10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-md bg-brand flex items-center justify-center font-bold text-sm">
            IP
          </div>
          <div>
            <p className="font-semibold leading-tight">Internship Pilot</p>
            <p className="text-xs text-slate-400 leading-tight">Local & private</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const active = pathname?.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-brand text-white"
                  : "text-slate-300 hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon className="w-4.5 h-4.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-4 py-4 border-t border-white/10 text-xs text-slate-400">
        <p>Everything runs on your computer.</p>
        <p>Ollama + SQLite, no cloud.</p>
      </div>
    </aside>
  );
}

function ProfileIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
      <circle cx="10" cy="6.5" r="3.2" />
      <path d="M3.5 17c0-3.3 3-5.2 6.5-5.2S16.5 13.7 16.5 17" strokeLinecap="round" />
    </svg>
  );
}

function JobsIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
      <rect x="3" y="6.5" width="14" height="9.5" rx="1.5" />
      <path d="M7 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 13 5v1.5" />
      <path d="M3 10.5h14" />
    </svg>
  );
}

function WatchlistIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="2.2" />
    </svg>
  );
}

function ReviewIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
      <path d="M10 3l6.5 3.5v7L10 17l-6.5-3.5v-7L10 3Z" strokeLinejoin="round" />
      <path d="M7.5 10l1.8 1.8L12.8 8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NearbyIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
      <path d="M10 18s6-5.2 6-9.8A6 6 0 0 0 4 8.2C4 12.8 10 18 10 18Z" strokeLinejoin="round" />
      <circle cx="10" cy="8.2" r="2.1" />
    </svg>
  );
}

function DocumentsIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
      <path d="M6 3h6l3 3v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
      <path d="M7.5 9h5M7.5 12h5M7.5 15h3" strokeLinecap="round" />
    </svg>
  );
}

function TrackerIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
      <path d="M4 4v12" strokeLinecap="round" />
      <path d="M4 5.5h9l-2 2.25 2 2.25H4" strokeLinejoin="round" />
    </svg>
  );
}

function SecurityIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
      <path d="M10 3l6 2.5v4c0 4-2.6 6.9-6 7.5-3.4-.6-6-3.5-6-7.5v-4L10 3Z" strokeLinejoin="round" />
      <path d="M7.5 10l1.6 1.6 3.4-3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AssessmentIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
      <rect x="4" y="3" width="12" height="14" rx="1.5" />
      <path d="M7 7.5h6M7 10.5h6M7 13.5h3" strokeLinecap="round" />
    </svg>
  );
}
