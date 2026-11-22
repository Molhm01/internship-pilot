"use client";

import { useState } from "react";
import { cn } from "@/components/ui/cn";
import { Globe, Puzzle, Server, Cpu, Building2, HardDrive } from "lucide-react";

type Node = {
  id: string;
  label: string;
  sub: string;
  icon: React.ComponentType<{ className?: string }>;
  detail: string;
  local: boolean;
};

const NODES: Node[] = [
  {
    id: "web",
    label: "Internship Pilot",
    sub: "Next.js Control Plane",
    icon: Globe,
    local: true,
    detail:
      "Multi-source radar discovery, 100% ATS scoring, tailored PDF generation, and live run tracking across local and cloud workspaces.",
  },
  {
    id: "profile",
    label: "Candidate Vault",
    sub: "Structured Profile + Facts",
    icon: HardDrive,
    local: true,
    detail:
      "Verified contact info, education, experience bullets, work authorization, and preferences extracted once from your resume.",
  },
  {
    id: "extension",
    label: "Document Compiler",
    sub: "PDF Engine + QA Guard",
    icon: Puzzle,
    local: true,
    detail:
      "Builds custom-tailored resume and cover letter PDFs per job, scrubbing unverified claims automatically with zero manual edits.",
  },
  {
    id: "agent",
    label: "Autonomous Runner",
    sub: "Local & Cloud Execution",
    icon: Server,
    local: true,
    detail:
      "Runs the Observe → Decide → Act → Verify → Submit loop automatically above your match floor using Playwright or ATS APIs.",
  },
  {
    id: "model",
    label: "ATS Scoring Engine",
    sub: "100% Catalog Scoring",
    icon: Cpu,
    local: true,
    detail:
      "Immediately evaluates every fresh (<7 day) internship against your uploaded resume so 0 active postings remain unscored.",
  },
  {
    id: "ats",
    label: "Employer ATS",
    sub: "Greenhouse · Lever · Ashby · Workday",
    icon: Building2,
    local: false,
    detail:
      "The target career portal. The Agent interacts with real DOM controls, verifies employer state commits, and captures submission confirmations.",
  },
];

/**
 * Public architecture diagram.
 */
export function ArchitectureDiagram() {
  const [activeId, setActiveId] = useState<string>("agent");
  const active = NODES.find((node) => node.id === activeId) ?? NODES[0];

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:gap-8">
      <ol className="relative space-y-1.5">
        <span
          aria-hidden
          className="pointer-events-none absolute left-[1.0625rem] top-4 bottom-4 w-px bg-hairline"
        />
        {NODES.map((node) => {
          const Icon = node.icon;
          const selected = node.id === activeId;
          return (
            <li key={node.id} className="relative">
              <button
                type="button"
                onMouseEnter={() => setActiveId(node.id)}
                onFocus={() => setActiveId(node.id)}
                onClick={() => setActiveId(node.id)}
                aria-pressed={selected}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left",
                  "transition-colors duration-[140ms] ease-standard",
                  selected
                    ? "border-accent-line bg-accent-quiet"
                    : "border-transparent hover:border-hairline hover:bg-surface",
                )}
              >
                <span
                  className={cn(
                    "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md border",
                    selected
                      ? "border-accent-line bg-surface text-accent"
                      : "border-hairline bg-surface text-tertiary",
                  )}
                >
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-small font-medium text-primary">{node.label}</span>
                  <span className="block truncate font-mono text-micro text-tertiary">
                    {node.sub}
                  </span>
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-sm border px-1.5 py-0.5 text-micro font-medium uppercase tracking-[0.06em]",
                    node.local
                      ? "border-verified-line bg-verified-quiet text-verified"
                      : "border-line bg-sunken text-tertiary",
                  )}
                >
                  {node.local ? "managed" : "external"}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="lg:sticky lg:top-20 lg:self-start">
        <div className="rounded-lg border border-hairline bg-surface p-5 shadow-raised">
          <p className="text-micro font-medium uppercase tracking-[0.075em] text-faint">
            {active.sub}
          </p>
          <p className="mt-2 font-display text-subhead font-semibold text-primary">{active.label}</p>
          <p className="mt-2 text-small text-secondary">{active.detail}</p>
          <div className="mt-4 flex items-center gap-2 border-t border-hairline pt-3">
            <span
              className={cn(
                "size-1.5 rounded-full",
                active.local ? "bg-verified" : "bg-tertiary",
              )}
              aria-hidden
            />
            <p className="text-micro text-tertiary">
              {active.local
                ? "Runs locally or on cloud workers. Profile data stays isolated to your account."
                : "Target employer portal verified through live DOM reads and official URL resolution."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
