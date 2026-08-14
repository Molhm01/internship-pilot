"use client";

import { useState } from "react";
import { cn } from "@/components/ui/cn";

type Level = "working" | "experimental" | "in-development" | "planned";

const LEVELS: Record<Level, { label: string; className: string }> = {
  working: {
    label: "Working",
    className: "border-verified-line bg-verified-quiet text-verified",
  },
  experimental: {
    label: "Experimental",
    className: "border-caution-line bg-caution-quiet text-caution",
  },
  "in-development": {
    label: "In development",
    className: "border-info-line bg-info-quiet text-info",
  },
  planned: {
    label: "Planned",
    className: "border-line bg-sunken text-tertiary",
  },
};

type Feature = { name: string; level: Level; note?: string };

type Group = { area: string; features: Feature[] };

/**
 * Feature status.
 *
 * Sourced from the project's own account of what is implemented versus actively
 * being worked on. Nothing is marked Working unless it genuinely is — an
 * overstated status board is the fastest way to lose an engineer's trust, and
 * the honesty is itself part of what the project is demonstrating.
 */
const GROUPS: Group[] = [
  {
    area: "Discovery & matching",
    features: [
      { name: "Internship discovery feed", level: "working" },
      { name: "Source verification states", level: "working" },
      { name: "AI Match scoring", level: "working", note: "Local model" },
      { name: "Match explanation & skill gaps", level: "working" },
      { name: "Saved filter presets", level: "in-development" },
    ],
  },
  {
    area: "Profile & documents",
    features: [
      { name: "Structured candidate profile", level: "working" },
      { name: "Résumé fact extraction", level: "working" },
      { name: "Tailored résumé generation", level: "working" },
      { name: "Cover letter generation", level: "working" },
      { name: "Document QA & identity guard", level: "working" },
    ],
  },
  {
    area: "Agent — core loop",
    features: [
      { name: "Observe → Decide → Act → Verify", level: "working" },
      { name: "Application page scanning", level: "working" },
      { name: "Field detection", level: "working" },
      { name: "Text field autofill", level: "working" },
      { name: "Verification of committed values", level: "working" },
      { name: "Needs-user-input handoff", level: "working" },
      { name: "Final-submit protection", level: "working", note: "Never automated" },
      { name: "Run traces & diagnostics", level: "working" },
    ],
  },
  {
    area: "Agent — form controls",
    features: [
      { name: "Custom dropdown recognition", level: "working" },
      { name: "Dropdown opening", level: "working" },
      { name: "Employer option enumeration", level: "working" },
      { name: "Reliable real-option selection", level: "in-development", note: "Varies by ATS" },
      { name: "Searchable dropdowns", level: "in-development" },
      { name: "Multi-choice & radio reliability", level: "in-development" },
      { name: "Dependent field chains", level: "in-development" },
      { name: "Exact date handling", level: "in-development" },
      { name: "Repeated experience sections", level: "in-development" },
      { name: "Repeated education sections", level: "in-development" },
      { name: "Document attachment controls", level: "in-development" },
    ],
  },
  {
    area: "Coverage",
    features: [
      { name: "Greenhouse", level: "experimental" },
      { name: "Lever", level: "experimental" },
      { name: "Ashby", level: "experimental" },
      { name: "Workday", level: "in-development" },
      { name: "iCIMS", level: "in-development" },
      { name: "SmartRecruiters", level: "in-development" },
      { name: "Employer account creation", level: "planned" },
    ],
  },
];

const FILTERS: Array<{ id: Level | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "working", label: "Working" },
  { id: "experimental", label: "Experimental" },
  { id: "in-development", label: "In development" },
  { id: "planned", label: "Planned" },
];

export function StatusBoard() {
  const [filter, setFilter] = useState<Level | "all">("all");

  const groups = GROUPS.map((group) => ({
    ...group,
    features: filter === "all" ? group.features : group.features.filter((f) => f.level === filter),
  })).filter((group) => group.features.length > 0);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-1.5">
        {FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setFilter(option.id)}
            aria-pressed={filter === option.id}
            className={cn(
              "h-6 rounded-md border px-2 text-micro font-medium transition-colors duration-[120ms] ease-standard",
              filter === option.id
                ? "border-accent-line bg-accent-quiet text-primary"
                : "border-line bg-surface text-tertiary hover:border-line-strong hover:text-primary",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* Multi-column rather than grid: an odd number of groups in a 2-up grid
          leaves an empty cell, and these blocks have very different heights. */}
      <div className="columns-1 gap-4 md:columns-2 [&>*]:mb-4 [&>*]:break-inside-avoid">
        {groups.map((group) => (
          <section
            key={group.area}
            className="rounded-lg border border-hairline bg-surface p-4"
          >
            <h3 className="mb-2.5 text-micro font-medium uppercase tracking-[0.075em] text-faint">
              {group.area}
            </h3>
            <ul className="space-y-px">
              {group.features.map((feature) => (
                <li
                  key={feature.name}
                  className="flex items-center gap-3 border-b border-hairline py-1.5 last:border-0"
                >
                  <span className="min-w-0 flex-1 truncate text-small text-secondary">
                    {feature.name}
                    {feature.note && (
                      <span className="ml-2 font-mono text-micro text-faint">{feature.note}</span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-sm border px-1.5 py-0.5 text-micro font-medium uppercase tracking-[0.06em]",
                      LEVELS[feature.level].className,
                    )}
                  >
                    {LEVELS[feature.level].label}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-4 text-micro text-faint">
        Coverage marked experimental has been exercised against real public postings in read-only
        inspections; it is not a production reliability claim.
      </p>
    </div>
  );
}
