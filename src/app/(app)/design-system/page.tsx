import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Label,
  Metric,
  MetricRow,
  Mono,
  Notice,
  Panel,
  PanelHeader,
  Section,
  Select,
  SkeletonRows,
  TD,
  TH,
  THead,
  TR,
  Table,
  Textarea,
} from "@/components/ui";

export const metadata = { title: "Design system — Internship Pilot" };

/**
 * Living reference for the design system.
 *
 * Rendered from the real primitives rather than mocked up, so it cannot drift
 * from what the product actually uses. This is the surface to audit against in
 * the final visual pass.
 */
export default function DesignSystemPage() {
  return (
    <div className="mx-auto max-w-5xl px-10 py-14 space-y-16">
      <header className="space-y-3 border-b border-line pb-8">
        <Label as="p">Internship Pilot</Label>
        <h1 className="text-title text-primary">Design system</h1>
        <p className="max-w-2xl text-body text-secondary">
          Hairlines instead of stacked cards. Radii small enough to read as machined. No glow, no
          gradients. Weight carried by type, spacing and tabular data rather than by containers.
        </p>
      </header>

      {/* ---------------------------------------------------------------- type */}
      <Section
        title="Typography"
        description="Geist Sans for interface text, Geist Mono for every value the product measures. Self-hosted — no network fetch at build or runtime."
      >
        <div className="space-y-6">
          <TypeSpecimen name="display / 52 · -0.032em" className="text-display">
            Verified today
          </TypeSpecimen>
          <TypeSpecimen name="title / 34 · -0.026em" className="text-title">
            Electrical Engineering Intern
          </TypeSpecimen>
          <TypeSpecimen name="heading / 22 · -0.019em" className="text-heading">
            Tailored documents
          </TypeSpecimen>
          <TypeSpecimen name="subhead / 17 · -0.012em" className="text-subhead">
            Official destination verified
          </TypeSpecimen>
          <TypeSpecimen name="body / 14" className="text-body text-secondary">
            The Application Agent fills employer forms from your profile. Anything left blank is
            left blank on the form too — it is never guessed.
          </TypeSpecimen>
          <TypeSpecimen name="small / 13" className="text-small text-secondary">
            Currently listed on the discovery source. Official destination not yet verified.
          </TypeSpecimen>
          <TypeSpecimen name="micro / 11 · +0.075em · uppercase" className="text-micro uppercase tracking-[0.075em] text-tertiary">
            Verification pending
          </TypeSpecimen>
          <TypeSpecimen name="mono / tabular figures">
            <span className="font-mono tabular text-body">
              1,284 · 97.4% · 2026-08-14 09:41 · REQ-40817-B
            </span>
          </TypeSpecimen>
        </div>
      </Section>

      {/* --------------------------------------------------------------- color */}
      <Section
        title="Neutral ramp"
        description="Slightly cool. Steps crowd at the light end because that is where surfaces and hairlines separate without a shadow."
      >
        <div className="flex flex-wrap gap-px overflow-hidden rounded-md border border-hairline">
          {[
            ["0", "bg-n-0"],
            ["25", "bg-n-25"],
            ["50", "bg-n-50"],
            ["100", "bg-n-100"],
            ["150", "bg-n-150"],
            ["200", "bg-n-200"],
            ["300", "bg-n-300"],
            ["400", "bg-n-400"],
            ["500", "bg-n-500"],
            ["600", "bg-n-600"],
            ["700", "bg-n-700"],
            ["800", "bg-n-800"],
            ["900", "bg-n-900"],
            ["950", "bg-n-950"],
          ].map(([step, klass]) => (
            <div key={step} className="flex-1 min-w-14">
              <div className={`h-14 ${klass}`} />
              <div className="border-t border-hairline bg-surface px-1.5 py-1 text-center font-mono text-micro text-tertiary">
                {step}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Semantic tones" description="Desaturated on purpose. Saturated status colour beside dense text is what makes a tool look like a toy.">
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 md:grid-cols-3">
          <Swatch name="accent" varName="--accent" className="bg-accent" />
          <Swatch name="positive" varName="--positive" className="bg-positive" />
          <Swatch name="caution" varName="--caution" className="bg-caution" />
          <Swatch name="critical" varName="--critical" className="bg-critical" />
          <Swatch name="info" varName="--info" className="bg-info" />
          <Swatch name="line" varName="--line" className="bg-line" />
        </div>
      </Section>

      {/* --------------------------------------------------------------- radii */}
      <Section title="Radii" description="The ceiling is 8px and almost nothing reaches it. Pills are reserved for status dots.">
        <div className="flex flex-wrap items-end gap-6">
          {[
            ["xs · 2", "rounded-xs"],
            ["sm · 3", "rounded-sm"],
            ["md · 4", "rounded-md"],
            ["lg · 6", "rounded-lg"],
            ["xl · 8", "rounded-xl"],
          ].map(([name, klass]) => (
            <div key={name} className="space-y-2">
              <div className={`size-16 border border-line-strong bg-sunken ${klass}`} />
              <div className="font-mono text-micro text-tertiary">{name}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ------------------------------------------------------------- buttons */}
      <Section title="Buttons" description="Flat fills, colour-step press states, 24 / 28 / 34px heights.">
        <div className="space-y-5">
          <ControlRow label="Variants">
            <Button variant="primary">Run AI Match</Button>
            <Button variant="secondary">Load more</Button>
            <Button variant="ghost">Clear filters</Button>
            <Button variant="danger">Delete job</Button>
          </ControlRow>
          <ControlRow label="Sizes">
            <Button size="sm" variant="primary">Small</Button>
            <Button size="md" variant="primary">Medium</Button>
            <Button size="lg" variant="primary">Large</Button>
          </ControlRow>
          <ControlRow label="Disabled">
            <Button variant="primary" disabled>Queuing…</Button>
            <Button variant="secondary" disabled>Unavailable</Button>
          </ControlRow>
        </div>
      </Section>

      {/* -------------------------------------------------------------- badges */}
      <Section title="Badges" description="Square-ish, not pills. Dots mark live or eventful states.">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="positive">Official destination verified</Badge>
          <Badge tone="info">Source listed</Badge>
          <Badge tone="caution">Verification pending</Badge>
          <Badge tone="critical">Closed confirmed</Badge>
          <Badge tone="neutral">Discovered</Badge>
          <Badge tone="accent" dot>Scoring</Badge>
          <Badge tone="caution" dot>Scoring delayed</Badge>
        </div>
      </Section>

      {/* ------------------------------------------------------------- metrics */}
      <Section
        title="Metrics"
        description="Divided readout rather than a grid of bordered tiles — the weight belongs on the values, which is the actual information."
      >
        <MetricRow>
          <Metric label="Active jobs" value="1,284" tone="accent" />
          <Metric label="Officially verified" value="416" tone="positive" />
          <Metric label="Source listed" value="702" tone="info" />
          <Metric label="Pending" value="166" tone="caution" />
          <Metric label="Scored" value="1,109" />
          <Metric label="Unscored" value="175" tone="caution" />
          <Metric label="Closed" value="38" tone="critical" />
        </MetricRow>
      </Section>

      {/* ------------------------------------------------------------ grouping */}
      <Section
        title="Grouping"
        description="Section is the default and groups with a rule. Panel is reserved for content that genuinely needs enclosing."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Panel>
            <p className="text-small font-medium text-primary">Panel · default</p>
            <p className="mt-1 text-small text-secondary">
              For a distinct object: a job, a run, an editable form.
            </p>
          </Panel>
          <Panel tone="sunken">
            <p className="text-small font-medium text-primary">Panel · sunken</p>
            <p className="mt-1 text-small text-secondary">Recedes behind primary content.</p>
          </Panel>
          <Panel tone="accent">
            <p className="text-small font-medium text-accent-text">Panel · accent</p>
            <p className="mt-1 text-small text-secondary">One per screen at most.</p>
          </Panel>
          <Panel tone="critical">
            <p className="text-small font-medium text-critical">Panel · critical</p>
            <p className="mt-1 text-small text-secondary">Security quarantine, failed runs.</p>
          </Panel>
        </div>

        <Panel flush className="mt-4">
          <PanelHeader
            title="Panel with header"
            description="Flush padding so the table manages its own."
            actions={<Button size="sm">Export</Button>}
          />
          <Table>
            <THead>
              <TR>
                <TH>Employer</TH>
                <TH>Sector</TH>
                <TH>Fit</TH>
                <TH align="right">Openings</TH>
                <TH align="right">Last checked</TH>
              </TR>
            </THead>
            <tbody>
              {[
                ["L3Harris Technologies", "Aerospace & Defense", "High", 12, "2026-08-14 09:41"],
                ["Analog Devices", "Semiconductor", "High", 7, "2026-08-14 08:02"],
                ["Eaton", "Industrial", "Medium", 3, "2026-08-13 22:15"],
                ["Honeywell", "Industrial", "Medium", 0, "2026-08-13 19:48"],
              ].map(([name, sector, fit, openings, checked]) => (
                <TR key={String(name)} interactive>
                  <TD className="font-medium text-primary">{name}</TD>
                  <TD>{sector}</TD>
                  <TD>
                    <Badge tone={fit === "High" ? "positive" : "neutral"}>{String(fit)}</Badge>
                  </TD>
                  <TD numeric>{openings}</TD>
                  <TD numeric className="text-tertiary">{checked}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Panel>
      </Section>

      {/* ------------------------------------------------------------ controls */}
      <Section title="Form controls" description="28px tall. One consolidated Field replaces three independently declared copies.">
        <div className="grid max-w-2xl gap-4 md:grid-cols-2">
          <Field label="Job title" htmlFor="ds-title">
            <Input id="ds-title" placeholder="e.g. Electrical Engineering Intern" />
          </Field>
          <Field label="Availability" htmlFor="ds-availability">
            <Select id="ds-availability" defaultValue="">
              <option value="">Active feed</option>
              <option value="official">Officially verified</option>
              <option value="source_listed">Source listed</option>
            </Select>
          </Field>
          <Field label="Notes" hint="Optional." htmlFor="ds-notes" className="md:col-span-2">
            <Textarea id="ds-notes" rows={3} placeholder="Paste the job description…" />
          </Field>
          <Field label="GPA" error="Must be between 0 and 4.0." htmlFor="ds-gpa">
            <Input id="ds-gpa" defaultValue="4.7" aria-invalid />
          </Field>
        </div>
      </Section>

      {/* -------------------------------------------------------------- states */}
      <Section title="States" description="Shared primitives so no two screens invent their own loading text.">
        <div className="space-y-4">
          <div>
            <Label className="mb-2">Loading</Label>
            <SkeletonRows rows={3} />
          </div>
          <div>
            <Label className="mb-2">Empty</Label>
            <EmptyState
              title="No jobs match these filters"
              description="Jobs loaded successfully, but nothing matched. Try Sync Now, or loosen the filters above."
              action={<Button variant="secondary">Clear filters</Button>}
            />
          </div>
          <div className="space-y-2">
            <Label className="mb-2">Error and notices</Label>
            <ErrorState
              title="Jobs API route missing"
              message="Rebuild and restart the Internship-AI web process."
            />
            <Notice tone="caution">
              The official employer application page has not been resolved yet.
            </Notice>
            <Notice tone="positive">Queued 175 jobs for scoring.</Notice>
          </div>
        </div>
      </Section>

      <footer className="border-t border-hairline pt-6">
        <p className="text-small text-tertiary">
          Rendered from <Mono>src/components/ui</Mono> — this page cannot drift from the
          primitives the product actually uses.
        </p>
      </footer>
    </div>
  );
}

function TypeSpecimen({
  name,
  className,
  children,
}: {
  name: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 border-b border-hairline pb-5 md:grid-cols-[13rem_1fr] md:gap-6">
      <div className="pt-1 font-mono text-micro text-faint">{name}</div>
      <div className={className}>{children}</div>
    </div>
  );
}

function Swatch({
  name,
  varName,
  className,
}: {
  name: string;
  varName: string;
  className: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className={`size-9 shrink-0 rounded-md border border-hairline ${className}`} />
      <div className="min-w-0">
        <div className="text-small text-primary">{name}</div>
        <div className="truncate font-mono text-micro text-faint">{varName}</div>
      </div>
    </div>
  );
}

function ControlRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 md:grid-cols-[7rem_1fr] md:gap-6">
      <div className="pt-1 font-mono text-micro text-faint">{label}</div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
