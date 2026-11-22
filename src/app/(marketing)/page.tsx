import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Check,
  Compass,
  FileText,
  Gauge,
  Layers,
  MonitorSmartphone,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { HeroSequence } from "@/components/marketing/HeroSequence";
import { Shell, SectionTag, SectionTitle, Lede, Reveal } from "@/components/marketing/sections";
import { ArchitectureDiagram } from "@/components/marketing/ArchitectureDiagram";
import { StatusBoard } from "@/components/marketing/StatusBoard";

export const metadata = {
  title: "Autonomous Internship Search & Application System",
  description:
    "Discover fresh (<7d) engineering internships across live radars, get 100% instant ATS match scoring, compile tailored PDFs, and auto-submit applications hands-free.",
};

export default function LandingPage() {
  return (
    <>
      {/* ==================================================== hero */}
      <section className="relative overflow-hidden pt-28 pb-20 lg:pt-36 lg:pb-28">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-grid mask-fade-edges opacity-70"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-px w-[70%] -translate-x-1/2 bg-accent/25"
        />

        <Shell wide className="relative">
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
            <div>
              <Reveal>
                <SectionTag>Cloud &amp; Local Autonomous Engine</SectionTag>
              </Reveal>

              <Reveal delay={0.05}>
                <h1 className="mt-4 font-display text-display font-semibold tracking-tight text-primary text-balance lg:text-hero">
                  Fresh internships, applied automatically.
                </h1>
              </Reveal>

              <Reveal delay={0.1}>
                <p className="mt-5 max-w-lg text-body text-secondary text-pretty">
                  Live crawlers pull fresh roles posted within the last 7 days, score 100% of
                  internships instantly against your resume, compile tailored PDFs, and submit
                  applications end-to-end without manual edits.
                </p>
              </Reveal>

              <Reveal delay={0.15}>
                <div className="mt-7 flex flex-wrap items-center gap-2.5">
                  <Link
                    href="/jobs"
                    className="group inline-flex h-9 shrink-0 whitespace-nowrap items-center gap-2 rounded-md border border-accent bg-accent px-4 text-small font-medium text-inverse transition-colors duration-[120ms] ease-standard hover:bg-accent-hover"
                  >
                    Explore internships
                    <ArrowRight
                      className="size-4 transition-transform duration-[180ms] ease-standard group-hover:translate-x-0.5"
                      aria-hidden
                    />
                  </Link>
                  <Link
                    href="/agent"
                    className="inline-flex h-9 shrink-0 whitespace-nowrap items-center gap-2 rounded-md border border-line bg-surface px-4 text-small font-medium text-primary shadow-raised transition-colors duration-[120ms] ease-standard hover:border-line-strong hover:bg-n-150"
                  >
                    <Bot className="size-4 text-accent" aria-hidden />
                    Open Auto-Pilot
                  </Link>
                </div>
              </Reveal>

              <Reveal delay={0.2}>
                <p className="mt-6 flex items-center gap-2 text-micro text-tertiary">
                  <ShieldCheck className="size-3.5 shrink-0 text-verified" aria-hidden />
                  Runs locally or in the cloud. Zero manual approval gates.
                </p>
              </Reveal>
            </div>

            <Reveal delay={0.12}>
              <HeroSequence />
            </Reveal>
          </div>
        </Shell>
      </section>

      {/* ==================================================== problem */}
      <section id="product" className="scroll-mt-16 border-t border-hairline py-20 lg:py-28">
        <Shell wide>
          <Reveal>
            <SectionTag>Why Internship Pilot</SectionTag>
            <SectionTitle>
              Applications are repetitive. Your engineering hours shouldn&rsquo;t be.
            </SectionTitle>
            <Lede>
              Instead of juggling stale multi-week boards, scattered resume drafts, and manual
              portal entry across ninety forms, Internship Pilot runs the entire pipeline from
              discovery to confirmed submission.
            </Lede>
          </Reveal>

          <div className="mt-10 grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline shadow-raised sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: Compass, title: "7-day fresh radar", body: "LinkedIn, Indeed, Handshake, Jobright, and direct ATS boards pruned to live postings." },
              { icon: Gauge, title: "100% scored catalog", body: "Every active internship receives an instant ATS fit score the moment you upload a resume." },
              { icon: FileText, title: "Auto-scrubbed PDFs", body: "Custom resume and cover letter PDFs compiled and verified automatically per posting." },
              { icon: Layers, title: "Hands-free Auto-Pilot", body: "Populates fields, selects custom React dropdowns, attaches PDFs, and submits autonomously." },
            ].map((item, index) => (
              <Reveal key={item.title} delay={index * 0.05} className="bg-surface">
                <div className="h-full p-5">
                  <item.icon className="size-4 text-accent" aria-hidden />
                  <p className="mt-3 font-display text-small font-semibold text-primary">{item.title}</p>
                  <p className="mt-1 text-small text-tertiary">{item.body}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={0.1}>
            <p className="mt-8 text-body text-secondary">
              One continuous autonomous pipeline:{" "}
              <span className="font-mono text-small text-primary">
                discover (&lt;=7d) → score (100%) → tailor PDF → verify DOM → auto-submit
              </span>
              .
            </p>
          </Reveal>
        </Shell>
      </section>

      {/* ==================================================== how it works */}
      <section
        id="how-it-works"
        className="scroll-mt-16 border-t border-hairline py-20 lg:py-28"
      >
        <Shell wide>
          <Reveal>
            <SectionTag>How it works</SectionTag>
            <SectionTitle>Upload one resume. Auto-Pilot handles the rest.</SectionTitle>
          </Reveal>

          <ol className="mt-10 grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline shadow-raised lg:grid-cols-5">
            {[
              { step: "01", title: "Discover <=7d", body: "Live radars aggregate fresh engineering roles and drop weeks-old listings." },
              { step: "02", title: "Score 100%", body: "Synchronous ATS evaluation scores every active role against your uploaded PDF." },
              { step: "03", title: "Tailor PDFs", body: "Job-specific resumes and cover letters compiled with automatic claim validation." },
              { step: "04", title: "Verify DOM", body: "Playwright inspects live employer controls and confirms every committed value." },
              { step: "05", title: "Auto-Submit", body: "Submits packets autonomously above your score threshold and logs confirmation." },
            ].map((item, index) => (
              <Reveal key={item.step} delay={index * 0.06} className="bg-surface">
                <li className="flex h-full flex-col p-5">
                  <span className="font-mono text-micro text-accent">{item.step}</span>
                  <p className="mt-2 font-display text-subhead font-semibold text-primary">{item.title}</p>
                  <p className="mt-1.5 text-small text-tertiary">{item.body}</p>
                </li>
              </Reveal>
            ))}
          </ol>
        </Shell>
      </section>

      {/* ==================================================== agent */}
      <section id="agent" className="scroll-mt-16 border-t border-hairline py-20 lg:py-28">
        <Shell wide>
          <div className="grid gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
            <div>
              <Reveal>
                <SectionTag>The Autonomous Agent</SectionTag>
                <SectionTitle>Real browser automation that verifies every commit.</SectionTitle>
                <Lede>
                  Employer portals are complex React applications with async validation, custom
                  menus, and dependent fields. Internship Pilot verifies DOM commitment after every
                  step before completing submission.
                </Lede>
              </Reveal>

              <Reveal delay={0.08}>
                <div className="mt-8 space-y-px overflow-hidden rounded-lg border border-hairline bg-hairline shadow-raised">
                  {[
                    { k: "Observe", v: "Scan live employer controls, file dropzones, and multi-step prompts." },
                    { k: "Decide", v: "Resolve field answers from your candidate vault and resume evidence." },
                    { k: "Act", v: "Fill inputs, drive custom dropdowns, and upload tailored PDFs." },
                    { k: "Submit", v: "Confirm DOM commits and execute final submission automatically." },
                  ].map((row) => (
                    <div key={row.k} className="flex gap-4 bg-surface px-4 py-3">
                      <span className="w-16 shrink-0 font-mono text-micro uppercase tracking-[0.06em] text-accent">
                        {row.k}
                      </span>
                      <span className="text-small text-secondary">{row.v}</span>
                    </div>
                  ))}
                </div>
              </Reveal>
            </div>

            <Reveal delay={0.06}>
              <VerificationContrast />
            </Reveal>
          </div>
        </Shell>
      </section>

      {/* ==================================================== architecture */}
      <section
        id="architecture"
        className="scroll-mt-16 border-t border-hairline py-20 lg:py-28"
      >
        <Shell wide>
          <Reveal>
            <SectionTag>Architecture</SectionTag>
            <SectionTitle>Built for both Cloud and Local runs.</SectionTitle>
            <Lede>
              Each user gets an isolated account, encrypted sessions, synchronous ATS scoring, and
              autonomous Playwright execution that works identically in hosted or local environments.
            </Lede>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="mt-10">
              <ArchitectureDiagram />
            </div>
          </Reveal>
        </Shell>
      </section>

      {/* ==================================================== engineering notes */}
      <section id="journey" className="scroll-mt-16 border-t border-hairline py-20 lg:py-28">
        <Shell wide>
          <Reveal>
            <SectionTag>Engineering design</SectionTag>
            <SectionTitle>Reliable execution across modern ATS portals.</SectionTitle>
          </Reveal>

          <div className="mt-10 grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline shadow-raised md:grid-cols-2">
            {[
              {
                icon: TerminalSquare,
                title: "Custom dropdown DOM state",
                body: "React, Ashby, and Workday menus ignore raw value injection. The runner opens live listboxes, searches real options, and clicks verified matches.",
              },
              {
                icon: Check,
                title: "Post-action DOM verification",
                body: "Every filled input is re-read and checked against validation errors before advancing pages or triggering submission.",
              },
              {
                icon: Sparkles,
                title: "Automatic claim scrubbing",
                body: "If a generated bullet touches an unverified requirement, the compiler automatically strips that clause so tailored PDFs never halt the pipeline.",
              },
              {
                icon: MonitorSmartphone,
                title: "Unified multi-radar normalization",
                body: "Direct ATS endpoints and job board radars deduplicate by requisition and normalize source timestamps to enforce the 7-day freshness window.",
              },
            ].map((item, index) => (
              <Reveal key={item.title} delay={index * 0.05} className="bg-surface">
                <article className="h-full p-6">
                  <item.icon className="size-4 text-accent" aria-hidden />
                  <h3 className="mt-3 font-display text-subhead font-semibold text-primary">{item.title}</h3>
                  <p className="mt-2 text-small text-secondary">{item.body}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </Shell>
      </section>

      {/* ==================================================== status */}
      <section id="status" className="scroll-mt-16 border-t border-hairline py-20 lg:py-28">
        <Shell wide>
          <Reveal>
            <SectionTag>System capabilities</SectionTag>
            <SectionTitle>Live pipeline readiness.</SectionTitle>
            <Lede>
              Current feature coverage across fresh discovery, 100% ATS scoring, tailored document
              compilation, and autonomous submission.
            </Lede>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="mt-10">
              <StatusBoard />
            </div>
          </Reveal>
        </Shell>
      </section>

      {/* ==================================================== close */}
      <section className="border-t border-hairline py-20 lg:py-28">
        <Shell>
          <Reveal>
            <div className="text-center">
              <h2 className="font-display text-title font-semibold tracking-tight text-primary text-balance">
                Stop filling the same forms ninety times.
              </h2>
              <p className="mx-auto mt-3 max-w-md text-body text-secondary">
                Create an account, drop in your resume, and let Auto-Pilot handle discovery,
                scoring, tailoring, and submission.
              </p>
              <div className="mt-7 flex flex-wrap justify-center gap-2.5">
                <Link
                  href="/jobs"
                  className="group inline-flex h-9 shrink-0 whitespace-nowrap items-center gap-2 rounded-md border border-accent bg-accent px-4 text-small font-medium text-inverse transition-colors duration-[120ms] ease-standard hover:bg-accent-hover"
                >
                  Explore internships
                  <ArrowRight
                    className="size-4 transition-transform duration-[180ms] ease-standard group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </Link>
                <Link
                  href="/signup"
                  className="inline-flex h-9 shrink-0 whitespace-nowrap items-center gap-2 rounded-md border border-line bg-surface px-4 text-small font-medium text-primary shadow-raised transition-colors duration-[120ms] ease-standard hover:bg-n-150"
                >
                  Create workspace
                </Link>
              </div>
            </div>
          </Reveal>
        </Shell>
      </section>
    </>
  );
}

function VerificationContrast() {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-hairline bg-surface p-5 shadow-raised">
        <p className="mb-3 text-micro font-medium uppercase tracking-[0.075em] text-faint">
          Execution pipeline
        </p>

        <div className="space-y-2">
          <div className="flex items-center gap-3 rounded-md border border-pending-line bg-pending-quiet px-3 py-2.5">
            <span className="size-1.5 shrink-0 rounded-full bg-pending" />
            <div className="min-w-0 flex-1">
              <p className="text-small font-medium text-primary">State / Province</p>
              <p className="font-mono text-micro text-tertiary">Driving live dropdown option…</p>
            </div>
            <span className="shrink-0 font-mono text-micro uppercase tracking-[0.06em] text-pending">
              acting
            </span>
          </div>

          <div className="flex items-center gap-3 rounded-md border border-verified-line bg-verified-quiet px-3 py-2.5">
            <Check className="size-4 shrink-0 text-verified" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-small font-medium text-primary">State / Province · Tailored PDF</p>
              <p className="font-mono text-micro text-verified">New Jersey · Resume_Tailored.pdf committed</p>
            </div>
            <span className="shrink-0 font-mono text-micro uppercase tracking-[0.06em] text-verified">
              verified
            </span>
          </div>

          <div className="flex items-center gap-3 rounded-md border border-accent-line bg-accent-quiet px-3 py-2.5">
            <Check className="size-4 shrink-0 text-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-small font-medium text-primary">Official ATS Submission</p>
              <p className="font-mono text-micro text-accent-text">Confirmation captured autonomously</p>
            </div>
            <span className="shrink-0 font-mono text-micro uppercase tracking-[0.06em] text-accent-text">
              submitted
            </span>
          </div>
        </div>

        <p className="mt-3 text-small text-tertiary">
          Every stage settles DOM state before advancing, producing verifiable confirmations across
          Greenhouse, Lever, Ashby, Workday, and iCIMS.
        </p>
      </div>
    </div>
  );
}
