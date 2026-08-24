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
    sub: "Next.js web app",
    icon: Globe,
    local: true,
    detail:
      "Discovery, AI Match, document generation and the candidate profile. Talks only to routes on this machine.",
  },
  {
    id: "profile",
    label: "Profile + job context",
    sub: "PostgreSQL",
    icon: HardDrive,
    local: true,
    detail:
      "The single source of truth the Agent is allowed to answer from. Sensitive answers are stored separately and only ever set by you.",
  },
  {
    id: "extension",
    label: "Browser extension",
    sub: "Content script",
    icon: Puzzle,
    local: true,
    detail:
      "Receives the application bundle over an in-page message bridge. Document bytes travel in the message payload, never in a URL.",
  },
  {
    id: "agent",
    label: "Local Agent server",
    sub: "localhost",
    icon: Server,
    local: true,
    detail:
      "Runs the Observe → Decide → Act → Verify loop and holds run state so a paused application can resume after you answer.",
  },
  {
    id: "model",
    label: "AI decision engine",
    sub: "Ollama",
    icon: Cpu,
    local: true,
    detail:
      "A model running on your own hardware. Used for matching, tailoring and field reasoning — never for inventing factual answers.",
  },
  {
    id: "ats",
    label: "Employer ATS",
    sub: "Greenhouse · Lever · Workday",
    icon: Building2,
    local: false,
    detail:
      "The only external system. The Agent interacts with the real page and re-reads it to verify what the employer accepted.",
  },
];

/**
 * Public architecture diagram.
 *
 * A vertical pipeline with hover/focus detail. Every node except the employer's
 * ATS is marked local, because that boundary is the product's central privacy
 * claim and it should be visible rather than asserted in prose.
 */
export function ArchitectureDiagram() {
  const [activeId, setActiveId] = useState<string>("agent");
  const active = NODES.find((node) => node.id === activeId) ?? NODES[0];

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:gap-8">
      <ol className="relative space-y-1.5">
        {/* the spine */}
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
                  <span className="block truncate text-small text-primary">{node.label}</span>
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
                  {node.local ? "local" : "external"}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="lg:sticky lg:top-20 lg:self-start">
        <div className="rounded-lg border border-hairline bg-surface p-5">
          <p className="text-micro font-medium uppercase tracking-[0.075em] text-faint">
            {active.sub}
          </p>
          <p className="mt-2 text-subhead text-primary">{active.label}</p>
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
                ? "Runs on your machine. Data does not leave it."
                : "The only system outside your machine."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
