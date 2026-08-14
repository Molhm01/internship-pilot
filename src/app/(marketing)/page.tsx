import Link from "next/link";
import {
  ArrowRight,
  Check,
  CircleDot,
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
  title: "From internship search to application, one intelligent system",
  description:
    "Discover engineering internships, understand your fit, tailor your materials, and let an AI Agent handle repetitive application work while you remain in control.",
};

export default function LandingPage() {
  return (
    <>
      {/* ==================================================== hero */}
      <section className="relative overflow-hidden pt-28 pb-20 lg:pt-36 lg:pb-28">
        {/* Technical grid, faded at the edges so it never ends in a hard line. */}
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
                <span className="inline-flex items-center gap-1.5 rounded-sm border border-caution-line bg-caution-quiet px-1.5 py-0.5 text-micro font-medium uppercase tracking-[0.06em] text-caution">
                  <CircleDot className="size-3" aria-hidden />
                  Advanced prototype
                </span>
              </Reveal>

              <Reveal delay={0.05}>
                <h1 className="mt-5 text-display text-primary text-balance lg:text-hero">
                  From internship search to application, one intelligent system.
                </h1>
              </Reveal>

              <Reveal delay={0.1}>
                <p className="mt-5 max-w-lg text-body text-secondary text-pretty">
                  Discover engineering internships, understand your fit, tailor your materials, and
                  let an AI Agent handle repetitive application work — while you remain in control.
                </p>
              </Reveal>

              <Reveal delay={0.15}>
                <div className="mt-7 flex flex-wrap items-center gap-2">
                  <Link
                    href="/jobs"
                    className="group inline-flex h-9 items-center gap-2 rounded-md border border-accent bg-accent px-3.5 text-small font-medium text-inverse transition-colors duration-[120ms] ease-standard hover:bg-accent-hover"
                  >
                    Explore internships
                    <ArrowRight
                      className="size-4 transition-transform duration-[180ms] ease-standard group-hover:translate-x-0.5"
                      aria-hidden
                    />
                  </Link>
                  <a
                    href="#agent"
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3.5 text-small font-medium text-primary transition-colors duration-[120ms] ease-standard hover:border-line-strong hover:bg-n-150"
                  >
                    See the Agent work
                  </a>
                </div>
              </Reveal>

              <Reveal delay={0.2}>
                <p className="mt-6 flex items-center gap-2 text-micro text-tertiary">
                  <ShieldCheck className="size-3.5 shrink-0 text-verified" aria-hidden />
                  Runs locally. The Agent never submits an application.
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
            <SectionTag>The problem</SectionTag>
            <SectionTitle>
              Applications are repetitive. Your work shouldn&rsquo;t be.
            </SectionTitle>
            <Lede>
              A single internship application is spread across a job board, a resume editor, a
              company research tab, an applicant tracking system, and a spreadsheet you update
              afterwards. Then you do it again, ninety more times.
            </Lede>
          </Reveal>

          <div className="mt-10 grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: Compass, title: "Scattered discovery", body: "Listings live across many sites, and some of them are not real." },
              { icon: Gauge, title: "Unclear fit", body: "Qualification bars are buried in prose and vary by employer." },
              { icon: FileText, title: "Manual tailoring", body: "Every posting wants different emphasis from the same experience." },
              { icon: Layers, title: "Repetitive entry", body: "The same facts, retyped into a different ATS every time." },
            ].map((item, index) => (
              <Reveal key={item.title} delay={index * 0.05} className="bg-surface">
                <div className="h-full p-5">
                  <item.icon className="size-4 text-tertiary" aria-hidden />
                  <p className="mt-3 text-small font-medium text-primary">{item.title}</p>
                  <p className="mt-1 text-small text-tertiary">{item.body}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={0.1}>
            <p className="mt-8 text-body text-secondary">
              Internship Pilot collapses that into one loop:{" "}
              <span className="font-mono text-small text-primary">
                discover → match → tailor → apply → review
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
            <SectionTitle>One profile. Every application.</SectionTitle>
          </Reveal>

          <ol className="mt-10 grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline lg:grid-cols-5">
            {[
              { step: "01", title: "Discover", body: "Engineering internships pulled from verified sources, newest first." },
              { step: "02", title: "Match", body: "A local model scores fit and shows the reasoning behind the number." },
              { step: "03", title: "Tailor", body: "Resume and cover letter generated from facts you approved." },
              { step: "04", title: "Apply", body: "The Agent fills what it knows and verifies the employer accepted it." },
              { step: "05", title: "Review", body: "You answer what it could not, check the form, and submit." },
            ].map((item, index) => (
              <Reveal key={item.step} delay={index * 0.06} className="bg-surface">
                <li className="flex h-full flex-col p-5">
                  <span className="font-mono text-micro text-accent">{item.step}</span>
                  <p className="mt-2 text-subhead text-primary">{item.title}</p>
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
                <SectionTag>The Agent</SectionTag>
                <SectionTitle>An application Agent that verifies its own work.</SectionTitle>
                <Lede>
                  Most autofill tools write a value into a field and call it done. Employer
                  application forms are React applications with custom dropdowns, dependent fields
                  and framework-managed state — writing a value is not the same as the employer
                  accepting it.
                </Lede>
              </Reveal>

              <Reveal delay={0.08}>
                <div className="mt-8 space-y-px overflow-hidden rounded-lg border border-hairline bg-hairline">
                  {[
                    { k: "Observe", v: "Scan the live page and enumerate real controls." },
                    { k: "Decide", v: "Resolve an answer from trusted profile facts, or stop." },
                    { k: "Act", v: "Open the real dropdown, click the real option." },
                    { k: "Verify", v: "Re-read the page to confirm the employer committed it." },
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

              <Reveal delay={0.12}>
                <div className="mt-8 space-y-3">
                  <p className="text-body text-primary">It fills what it knows. It asks when it doesn&rsquo;t.</p>
                  <p className="text-small text-secondary">
                    Unknown factual questions become{" "}
                    <span className="rounded-sm border border-needs-input-line bg-needs-input-quiet px-1 py-0.5 font-mono text-micro text-needs-input">
                      needs your input
                    </span>{" "}
                    rather than a guess. Demographic questions are never inferred at all — only a
                    preference you set yourself is ever used.
                  </p>
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
            <SectionTitle>Local by construction.</SectionTitle>
            <Lede>
              The web app, the Agent server, and the model all run on your machine. Your profile and
              your documents do not leave it.
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
            <SectionTag>Engineering notes</SectionTag>
            <SectionTitle>Why this is harder than autofill.</SectionTitle>
          </Reveal>

          <div className="mt-10 grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline md:grid-cols-2">
            {[
              {
                icon: TerminalSquare,
                title: "Custom dropdowns own their state",
                body: "A React or SuccessFactors dropdown is not a <select>. Setting a value directly is ignored by the framework, so the Agent opens the real menu, enumerates the real options, and clicks one.",
              },
              {
                icon: Check,
                title: "Writing is not committing",
                body: "The employer's own validation decides what actually landed. Every action is followed by a re-observation of the page, and only then reported as verified.",
              },
              {
                icon: Sparkles,
                title: "Absence of evidence is not an answer",
                body: "If a resume does not mention prior employment at a company, that is not a 'no'. Questions like this are routed to the user instead of inferred.",
              },
              {
                icon: MonitorSmartphone,
                title: "Every ATS disagrees",
                body: "Greenhouse, Lever, Ashby, Workday, iCIMS and SmartRecruiters each model the same form differently, which is why adapter coverage is tracked honestly below.",
              },
            ].map((item, index) => (
              <Reveal key={item.title} delay={index * 0.05} className="bg-surface">
                <article className="h-full p-6">
                  <item.icon className="size-4 text-accent" aria-hidden />
                  <h3 className="mt-3 text-subhead text-primary">{item.title}</h3>
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
            <SectionTag>Project status</SectionTag>
            <SectionTitle>Honest about what works.</SectionTitle>
            <Lede>
              This is an advanced working prototype in active development, not a finished product.
              Nothing below is marked working unless it genuinely is.
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
              <h2 className="text-title text-primary text-balance">
                Automation without giving up control.
              </h2>
              <p className="mx-auto mt-3 max-w-md text-body text-secondary">
                The Agent does the repetitive part. The last click stays yours.
              </p>
              <div className="mt-7 flex justify-center">
                <Link
                  href="/jobs"
                  className="group inline-flex h-9 items-center gap-2 rounded-md border border-accent bg-accent px-3.5 text-small font-medium text-inverse transition-colors duration-[120ms] ease-standard hover:bg-accent-hover"
                >
                  Explore internships
                  <ArrowRight
                    className="size-4 transition-transform duration-[180ms] ease-standard group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </Link>
              </div>
            </div>
          </Reveal>
        </Shell>
      </section>
    </>
  );
}

/**
 * The single most important distinction in the product, shown as a contrast
 * rather than described: an attempted action versus a verified one.
 */
function VerificationContrast() {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-hairline bg-surface p-4">
        <p className="mb-3 text-micro font-medium uppercase tracking-[0.075em] text-faint">
          Not the same thing
        </p>

        <div className="space-y-2">
          <div className="flex items-center gap-3 rounded-md border border-pending-line bg-pending-quiet px-3 py-2.5">
            <span className="size-1.5 shrink-0 animate-agent-pulse rounded-full bg-pending" />
            <div className="min-w-0 flex-1">
              <p className="text-small text-primary">State / Province</p>
              <p className="font-mono text-micro text-tertiary">Selecting New Jersey…</p>
            </div>
            <span className="shrink-0 font-mono text-micro uppercase tracking-[0.06em] text-pending">
              attempted
            </span>
          </div>

          <div className="flex items-center gap-3 rounded-md border border-verified-line bg-verified-quiet px-3 py-2.5">
            <Check className="size-4 shrink-0 text-verified" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-small text-primary">State / Province</p>
              <p className="font-mono text-micro text-verified">New Jersey · employer accepted</p>
            </div>
            <span className="shrink-0 font-mono text-micro uppercase tracking-[0.06em] text-verified">
              verified
            </span>
          </div>
        </div>

        <p className="mt-3 text-small text-tertiary">
          Only the second one counts. The Agent re-reads the page after every action and reports
          what the employer actually committed.
        </p>
      </div>

      <div className="rounded-lg border border-hairline bg-surface p-4">
        <p className="mb-2 text-micro font-medium uppercase tracking-[0.075em] text-faint">
          When it cannot know
        </p>
        <div className="flex items-start gap-3 rounded-md border border-needs-input-line bg-needs-input-quiet px-3 py-2.5">
          <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-needs-input" />
          <div className="min-w-0">
            <p className="text-small text-primary">Have you previously worked for this company?</p>
            <p className="mt-0.5 text-micro text-tertiary">
              Not answerable from your profile. The Agent pauses and preserves progress.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
