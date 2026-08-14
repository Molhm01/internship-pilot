"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  Check,
  Loader2,
  CircleHelp,
  ChevronDown,
  Lock,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/components/ui/cn";

/**
 * The hero product visualisation.
 *
 * Rather than an abstract 3D scene, this animates the thing the product is
 * actually for: an Agent working an employer application form, and — critically
 * — verifying that the employer accepted each action. Verification is the
 * technical differentiator, so it is the beat the sequence lands on.
 *
 * The sequence is a timed state machine rather than a video or Lottie file, so
 * it costs no network, scales to any width, respects reduced motion, and cannot
 * drift out of sync with the product's real vocabulary.
 */

type StageId = "observe" | "decide" | "act" | "verify";

const STAGES: { id: StageId; label: string }[] = [
  { id: "observe", label: "Observe" },
  { id: "decide", label: "Decide" },
  { id: "act", label: "Act" },
  { id: "verify", label: "Verify" },
];

type FieldState =
  | "idle"
  | "filling"
  | "verified"
  | "reading"
  | "selecting"
  | "needs-input"
  | "sensitive"
  | "skipped";

type FieldSpec = {
  id: string;
  label: string;
  value?: string;
  kind: "text" | "select" | "question";
};

const FIELDS: FieldSpec[] = [
  { id: "first", label: "First name", value: "Molham", kind: "text" },
  { id: "email", label: "Email address", value: "—", kind: "text" },
  { id: "school", label: "School", value: "—", kind: "text" },
  { id: "state", label: "State / Province", value: "New Jersey", kind: "select" },
  { id: "auth", label: "Work authorization", value: "—", kind: "select" },
  { id: "restriction", label: "Employment restriction", kind: "question" },
  { id: "eeo", label: "Demographic questions", kind: "question" },
];

/** One frame of the story: which stage is lit, and what each field looks like. */
type Frame = {
  stage: StageId;
  caption: string;
  detail?: string;
  fields: Partial<Record<string, FieldState>>;
  optionsRead?: number;
  log?: string;
  progress: number;
};

const FRAMES: Frame[] = [
  {
    stage: "observe",
    caption: "Scanning application",
    detail: "18 controls detected",
    fields: {},
    log: "Observed 18 controls",
    progress: 0,
  },
  {
    stage: "decide",
    caption: "Matching known profile facts",
    detail: "Trusted profile only",
    fields: { first: "filling", email: "filling" },
    log: "Resolved 6 fields from profile",
    progress: 8,
  },
  {
    stage: "act",
    caption: "Filling contact information",
    fields: { first: "verified", email: "verified", school: "filling" },
    log: "Filled Email address",
    progress: 22,
  },
  {
    stage: "verify",
    caption: "Employer accepted the values",
    fields: { first: "verified", email: "verified", school: "verified" },
    log: "Verified Email address",
    progress: 34,
  },
  {
    stage: "observe",
    caption: "Opening State / Province",
    detail: "Custom dropdown",
    fields: { first: "verified", email: "verified", school: "verified", state: "reading" },
    optionsRead: 58,
    log: "Opened State / Province",
    progress: 45,
  },
  {
    stage: "decide",
    caption: "Reading employer options",
    detail: "58 options enumerated",
    fields: { first: "verified", email: "verified", school: "verified", state: "reading" },
    optionsRead: 58,
    log: "Found 58 options",
    progress: 55,
  },
  {
    stage: "act",
    caption: "Selecting the real option",
    detail: "New Jersey",
    fields: { first: "verified", email: "verified", school: "verified", state: "selecting" },
    log: "Clicked New Jersey",
    progress: 66,
  },
  {
    stage: "verify",
    caption: "Selection committed",
    detail: "Employer accepted New Jersey",
    fields: {
      first: "verified",
      email: "verified",
      school: "verified",
      state: "verified",
      auth: "filling",
    },
    log: "Verified State / Province",
    progress: 78,
  },
  {
    stage: "verify",
    caption: "Two questions need you",
    detail: "The Agent will not guess",
    fields: {
      first: "verified",
      email: "verified",
      school: "verified",
      state: "verified",
      auth: "verified",
      restriction: "needs-input",
      eeo: "sensitive",
    },
    log: "Paused — awaiting user input",
    progress: 88,
  },
  {
    stage: "verify",
    caption: "Ready for review",
    detail: "Final submission is always yours",
    fields: {
      first: "verified",
      email: "verified",
      school: "verified",
      state: "verified",
      auth: "verified",
      restriction: "needs-input",
      eeo: "sensitive",
    },
    log: "Ready for review",
    progress: 100,
  },
];

const FRAME_MS = 1900;

export function HeroSequence() {
  const reduceMotion = useReducedMotion();
  const [index, bump] = useReducer((current: number) => (current + 1) % FRAMES.length, 0);
  const [paused, setPaused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(true);

  // Stops the timer when scrolled away. A hero that keeps re-rendering off
  // screen is exactly the kind of decoration that makes an app feel slow.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.15 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reduceMotion || paused || !inView) return;
    const timer = window.setInterval(bump, FRAME_MS);
    return () => window.clearInterval(timer);
  }, [reduceMotion, paused, inView]);

  // Reduced motion gets the final, most informative frame — not a blank box.
  const frame = reduceMotion ? FRAMES[FRAMES.length - 1] : FRAMES[index];
  const logs = useMemo(() => {
    if (reduceMotion) return FRAMES.map((f) => f.log).filter(Boolean).slice(-4) as string[];
    const window_ = FRAMES.slice(Math.max(0, index - 3), index + 1);
    return window_.map((f) => f.log).filter(Boolean) as string[];
  }, [index, reduceMotion]);

  return (
    <div
      ref={containerRef}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="relative"
    >
      {/* Screen-reader summary. The animation is decorative narration of a
          static truth, so assistive tech gets the truth directly. */}
      <p className="sr-only">
        An animated illustration of the Agent working an application form: it observes the page,
        decides using stored profile facts, acts, and verifies that the employer accepted each
        action. It pauses on questions it cannot answer, and never submits the application.
      </p>

      <div
        aria-hidden
        className="relative overflow-hidden rounded-xl border border-line bg-surface shadow-overlay"
      >
        {/* window chrome */}
        <div className="flex h-9 items-center gap-2 border-b border-hairline bg-raised px-3">
          <div className="flex gap-1.5">
            <span className="size-2 rounded-full bg-n-300" />
            <span className="size-2 rounded-full bg-n-300" />
            <span className="size-2 rounded-full bg-n-300" />
          </div>
          <div className="ml-2 flex h-5 min-w-0 flex-1 items-center gap-1.5 rounded-sm border border-hairline bg-surface px-2">
            <Lock className="size-2.5 shrink-0 text-faint" />
            <span className="truncate font-mono text-micro text-faint">
              careers.employer.com/apply/req-40817
            </span>
          </div>
          <span className="hidden shrink-0 items-center gap-1.5 rounded-sm border border-accent-line bg-accent-quiet px-1.5 py-0.5 text-micro font-medium uppercase tracking-[0.06em] text-accent-text sm:inline-flex">
            <span className="size-1.5 animate-agent-pulse rounded-full bg-accent" />
            Agent active
          </span>
        </div>

        <div className="grid gap-0 lg:grid-cols-[1fr_15rem]">
          {/* ------------------------------------------------ form column */}
          <div className="min-w-0 p-4">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-small font-medium text-primary">
                  Electrical Engineering Intern
                </p>
                <p className="truncate text-micro text-tertiary">
                  Aerospace &amp; Defense · Summer 2027
                </p>
              </div>
              <span className="shrink-0 font-mono text-micro text-faint tabular">
                {Math.round(frame.progress)}%
              </span>
            </div>

            {/* progress rail */}
            <div className="mb-4 h-0.5 w-full overflow-hidden rounded-full bg-n-200">
              <motion.div
                className="h-full bg-accent"
                animate={{ width: `${frame.progress}%` }}
                transition={{ duration: reduceMotion ? 0 : 0.6, ease: [0.2, 0, 0, 1] }}
              />
            </div>

            <ul className="space-y-px">
              {FIELDS.map((field) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  state={frame.fields[field.id] ?? "idle"}
                  optionsRead={field.id === "state" ? frame.optionsRead : undefined}
                  reduceMotion={Boolean(reduceMotion)}
                />
              ))}
            </ul>

            <div className="mt-4 flex items-center gap-2 border-t border-hairline pt-3">
              <ShieldCheck className="size-3.5 shrink-0 text-verified" />
              <p className="text-micro text-tertiary">
                Submit is never automated — final submission is always yours.
              </p>
            </div>
          </div>

          {/* ------------------------------------------------ agent column */}
          <div className="border-t border-hairline bg-raised p-3 lg:border-l lg:border-t-0">
            <p className="mb-2 text-micro font-medium uppercase tracking-[0.075em] text-faint">
              Agent
            </p>

            <ol className="mb-3 space-y-1">
              {STAGES.map((stage) => {
                const isCurrent = stage.id === frame.stage;
                return (
                  <li key={stage.id} className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full transition-colors duration-200",
                        isCurrent ? "bg-accent" : "bg-n-300",
                        isCurrent && !reduceMotion && "animate-agent-pulse",
                      )}
                    />
                    <span
                      className={cn(
                        "text-small transition-colors duration-200",
                        isCurrent ? "text-primary" : "text-faint",
                      )}
                    >
                      {stage.label}
                    </span>
                  </li>
                );
              })}
            </ol>

            <div className="mb-3 rounded-md border border-hairline bg-surface px-2 py-1.5">
              <motion.p
                key={frame.caption}
                initial={reduceMotion ? false : { opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
                className="text-small text-primary"
              >
                {frame.caption}
              </motion.p>
              {frame.detail && (
                <motion.p
                  key={frame.detail}
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, delay: 0.05 }}
                  className="mt-0.5 font-mono text-micro text-tertiary"
                >
                  {frame.detail}
                </motion.p>
              )}
            </div>

            <p className="mb-1.5 text-micro font-medium uppercase tracking-[0.075em] text-faint">
              Trace
            </p>
            <ul className="space-y-1">
              {logs.map((line, position) => (
                <motion.li
                  key={`${line}-${position}`}
                  initial={reduceMotion ? false : { opacity: 0, x: -4 }}
                  animate={{ opacity: position === logs.length - 1 ? 1 : 0.45, x: 0 }}
                  transition={{ duration: 0.25 }}
                  className="truncate font-mono text-micro text-tertiary"
                >
                  {line}
                </motion.li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldRow({
  field,
  state,
  optionsRead,
  reduceMotion,
}: {
  field: FieldSpec;
  state: FieldState;
  optionsRead?: number;
  reduceMotion: boolean;
}) {
  const dim = state === "idle";
  return (
    <li
      className={cn(
        "flex items-center gap-2.5 rounded-sm px-1.5 py-1.5 transition-colors duration-300",
        state === "needs-input" && "bg-needs-input-quiet",
        state === "sensitive" && "bg-sensitive-quiet",
        (state === "reading" || state === "selecting" || state === "filling") && "bg-accent-quiet",
      )}
    >
      <StateIcon state={state} reduceMotion={reduceMotion} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-small transition-colors duration-300",
          dim ? "text-faint" : "text-secondary",
        )}
      >
        {field.label}
      </span>
      <span className="shrink-0 text-right font-mono text-micro tabular">
        <StateValue field={field} state={state} optionsRead={optionsRead} />
      </span>
    </li>
  );
}

function StateIcon({ state, reduceMotion }: { state: FieldState; reduceMotion: boolean }) {
  const base = "size-3.5 shrink-0";
  switch (state) {
    case "verified":
      return <Check className={cn(base, "text-verified")} />;
    case "filling":
    case "selecting":
      return <Loader2 className={cn(base, "text-accent", !reduceMotion && "animate-spin")} />;
    case "reading":
      return <ChevronDown className={cn(base, "text-accent")} />;
    case "needs-input":
      return <CircleHelp className={cn(base, "text-needs-input")} />;
    case "sensitive":
      return <Lock className={cn(base, "text-sensitive")} />;
    default:
      return <span className={cn(base, "rounded-full border border-n-300")} />;
  }
}

function StateValue({
  field,
  state,
  optionsRead,
}: {
  field: FieldSpec;
  state: FieldState;
  optionsRead?: number;
}) {
  switch (state) {
    case "verified":
      return <span className="text-verified">{field.value ?? "Verified"}</span>;
    case "reading":
      return (
        <span className="text-accent-text">
          {optionsRead ? `reading ${optionsRead}…` : "reading…"}
        </span>
      );
    case "selecting":
      return <span className="text-accent-text">selecting…</span>;
    case "filling":
      return <span className="text-accent-text">typing…</span>;
    case "needs-input":
      return <span className="text-needs-input">needs you</span>;
    case "sensitive":
      return <span className="text-sensitive">never inferred</span>;
    default:
      return <span className="text-faint">—</span>;
  }
}
