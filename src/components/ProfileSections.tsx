"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The multi-user profile editor. Not mounted in local single-user mode.
 *
 * This writes to the per-account `UserProfile` / `ApplicationPreferences` /
 * `SensitiveAnswerPreferences` tables through `/api/profile/*`. In the local
 * deployment the canonical profile is the single `ApplicationProfile` row and
 * `CanonicalProfileForm` is what `/profile` renders instead — that row is the
 * one holding real data and the one the extension bundle is built from.
 *
 * Kept, unmounted, for the multi-user release this was written for. Deleting it
 * would mean rewriting it; it costs nothing to hold, and the routes it calls
 * are still live whenever INTERNSHIP_PILOT_SINGLE_USER is false.
 *
 * Every input is optional and empty means "not answered". Nothing here is
 * defaulted on the user's behalf, because a value they did not choose is one
 * the agent would then state on a real application.
 */

type Entry = Record<string, unknown> & { id: string };

type ProfilePayload = {
  user: { id: string; email: string; displayName: string | null } | null;
  profile: Record<string, string | null> | null;
  educations: Entry[];
  experiences: Entry[];
  projects: Entry[];
  preferences: Record<string, unknown> | null;
  sensitive: Record<string, unknown> | null;
  answers: Array<{ id: string; questionText: string; answer: string }>;
  gaps: string[];
};

const PERSONAL_FIELDS: Array<[string, string]> = [
  ["legalFirstName", "Legal first name"],
  ["middleName", "Middle name"],
  ["legalLastName", "Legal last name"],
  ["preferredName", "Preferred name"],
  ["applicationEmail", "Application email"],
  ["alternateEmail", "Alternate email"],
  ["phoneCountryCode", "Phone country code"],
  ["phone", "Phone number"],
  ["addressLine1", "Street address"],
  ["addressLine2", "Address line 2 (apartment, suite)"],
  ["city", "City"],
  ["state", "State / province"],
  ["postalCode", "Postal code"],
  ["country", "Country"],
  ["linkedinUrl", "LinkedIn URL"],
  ["githubUrl", "GitHub URL"],
  ["portfolioUrl", "Portfolio URL"],
];

const REUSABLE_QUESTIONS = [
  "Why this company?",
  "Why this position?",
  "What are your strengths?",
  "Describe a time you worked in a team.",
  "Describe a time you showed leadership.",
  "Describe a relevant project.",
  "Describe your relevant experience.",
  "Describe a challenge or failure.",
  "What is your availability?",
  "Are you willing to relocate?",
  "What are your salary expectations?",
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Text({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="input w-full"
    />
  );
}

function TriState({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className="input w-full">
      <option value="">Not answered — ask me each time</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="font-semibold text-slate-900">{title}</h2>
      {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function boolToSelect(value: unknown): string {
  return value === true ? "yes" : value === false ? "no" : "";
}

export default function ProfileSections() {
  const [data, setData] = useState<ProfilePayload | null>(null);
  const [personal, setPersonal] = useState<Record<string, string>>({});
  const [preferences, setPreferences] = useState<Record<string, string>>({});
  const [sensitive, setSensitive] = useState<Record<string, string>>({});
  const [declineDemographics, setDeclineDemographics] = useState(true);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/profile");
    if (!response.ok) return;
    const payload = (await response.json()) as ProfilePayload;
    setData(payload);

    const record = payload.profile ?? {};
    setPersonal(
      Object.fromEntries(PERSONAL_FIELDS.map(([key]) => [key, (record[key] as string) ?? ""])),
    );

    const prefs = payload.preferences ?? {};
    setPreferences({
      legallyAuthorizedToWork: boolToSelect(prefs.legallyAuthorizedToWork),
      requiresSponsorshipNow: boolToSelect(prefs.requiresSponsorshipNow),
      mayRequireSponsorshipLater: boolToSelect(prefs.mayRequireSponsorshipLater),
      willingToRelocate: boolToSelect(prefs.willingToRelocate),
      hasDriversLicense: boolToSelect(prefs.hasDriversLicense),
      remotePreference: (prefs.remotePreference as string) ?? "",
      earliestStartDate: (prefs.earliestStartDate as string) ?? "",
      salaryPreference: (prefs.salaryPreference as string) ?? "",
      securityClearanceStatus: (prefs.securityClearanceStatus as string) ?? "",
      usualJobSource: (prefs.usualJobSource as string) ?? "",
    });

    const sens = payload.sensitive ?? {};
    setSensitive({
      gender: (sens.gender as string) ?? "",
      raceEthnicity: (sens.raceEthnicity as string) ?? "",
      veteranStatus: (sens.veteranStatus as string) ?? "",
      disabilityStatus: (sens.disabilityStatus as string) ?? "",
      pronouns: (sens.pronouns as string) ?? "",
    });
    setDeclineDemographics(sens.declineDemographics !== false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(section: string, body: unknown) {
    setError(null);
    const response = await fetch(`/api/profile/${section}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "That could not be saved.");
      return;
    }
    setSaved(section);
    setTimeout(() => setSaved(null), 2500);
    await load();
  }

  async function addEntry(kind: string, body: Record<string, string>) {
    setError(null);
    const response = await fetch(`/api/profile/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "That could not be added.");
      return;
    }
    await load();
  }

  async function removeEntry(kind: string, id: string) {
    await fetch(`/api/profile/${kind}/${id}`, { method: "DELETE" });
    await load();
  }

  if (!data) return <p className="text-sm text-slate-600">Loading your profile…</p>;

  return (
    <div className="space-y-6">
      {data.gaps.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4" role="status">
          <p className="text-sm font-medium text-amber-900">
            Complete your Profile before using Application Agent.
          </p>
          <p className="mt-1 text-sm text-amber-800">Still needed: {data.gaps.join(", ")}.</p>
        </section>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {error}
        </p>
      )}
      {saved && <p className="text-sm text-emerald-700">Saved {saved}.</p>}

      <Section title="Personal information" description="What an application form asks for by name.">
        <div className="grid grid-cols-2 gap-4">
          {PERSONAL_FIELDS.map(([key, label]) => (
            <Field key={key} label={label}>
              <Text
                value={personal[key] ?? ""}
                onChange={(next) => setPersonal({ ...personal, [key]: next })}
              />
            </Field>
          ))}
        </div>
        <button
          onClick={() => void save("personal", personal)}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark"
        >
          Save personal information
        </button>
      </Section>

      <EntryList
        title="Education"
        kind="education"
        entries={data.educations}
        fields={[
          ["school", "School"],
          ["degree", "Degree"],
          ["major", "Major"],
          ["minor", "Minor"],
          ["startMonth", "Start month"],
          ["startYear", "Start year"],
          ["graduationMonth", "Graduation month"],
          ["graduationYear", "Graduation year"],
          ["gpa", "GPA"],
          ["educationLevel", "Education level"],
          ["relevantCoursework", "Relevant coursework (comma-separated)"],
        ]}
        onAdd={(body) => void addEntry("education", body)}
        onRemove={(id) => void removeEntry("education", id)}
      />

      <EntryList
        title="Experience"
        kind="experience"
        entries={data.experiences}
        fields={[
          ["employer", "Employer"],
          ["title", "Title"],
          ["location", "Location"],
          ["startDate", "Start date"],
          ["endDate", "End date"],
          ["responsibilities", "Approved responsibilities (one per line)"],
          ["approvedBullets", "Approved résumé bullets (one per line)"],
        ]}
        onAdd={(body) => void addEntry("experience", body)}
        onRemove={(id) => void removeEntry("experience", id)}
      />

      <EntryList
        title="Projects"
        kind="project"
        entries={data.projects}
        fields={[
          ["name", "Project name"],
          ["startDate", "Start date"],
          ["endDate", "End date"],
          ["technologies", "Technologies (comma-separated)"],
          ["description", "Approved description"],
          ["approvedSkills", "Approved skills (comma-separated)"],
        ]}
        onAdd={(body) => void addEntry("project", body)}
        onRemove={(id) => void removeEntry("project", id)}
      />

      <Section
        title="Application information"
        description="Left blank means the agent will ask you rather than guess."
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="Legally authorized to work">
            <TriState
              value={preferences.legallyAuthorizedToWork ?? ""}
              onChange={(next) => setPreferences({ ...preferences, legallyAuthorizedToWork: next })}
            />
          </Field>
          <Field label="Requires sponsorship now">
            <TriState
              value={preferences.requiresSponsorshipNow ?? ""}
              onChange={(next) => setPreferences({ ...preferences, requiresSponsorshipNow: next })}
            />
          </Field>
          <Field label="May require sponsorship later">
            <TriState
              value={preferences.mayRequireSponsorshipLater ?? ""}
              onChange={(next) =>
                setPreferences({ ...preferences, mayRequireSponsorshipLater: next })
              }
            />
          </Field>
          <Field label="Willing to relocate">
            <TriState
              value={preferences.willingToRelocate ?? ""}
              onChange={(next) => setPreferences({ ...preferences, willingToRelocate: next })}
            />
          </Field>
          <Field label="Holds a driving licence">
            <TriState
              value={preferences.hasDriversLicense ?? ""}
              onChange={(next) => setPreferences({ ...preferences, hasDriversLicense: next })}
            />
          </Field>
          <Field label="Remote-work preference">
            <select
              value={preferences.remotePreference ?? ""}
              onChange={(event) =>
                setPreferences({ ...preferences, remotePreference: event.target.value })
              }
              className="input w-full"
            >
              <option value="">Not answered</option>
              <option value="remote">Remote</option>
              <option value="hybrid">Hybrid</option>
              <option value="onsite">On-site</option>
              <option value="no_preference">No preference</option>
            </select>
          </Field>
          <Field label="Earliest start date (YYYY-MM-DD)">
            <Text
              value={preferences.earliestStartDate ?? ""}
              onChange={(next) => setPreferences({ ...preferences, earliestStartDate: next })}
              placeholder="2027-06-01"
            />
          </Field>
          <Field label="Salary preference">
            <Text
              value={preferences.salaryPreference ?? ""}
              onChange={(next) => setPreferences({ ...preferences, salaryPreference: next })}
              placeholder="Negotiable, or a figure you approve"
            />
          </Field>
          <Field label="Security-clearance status">
            <Text
              value={preferences.securityClearanceStatus ?? ""}
              onChange={(next) => setPreferences({ ...preferences, securityClearanceStatus: next })}
            />
          </Field>
          <Field label="How you normally hear about jobs">
            <Text
              value={preferences.usualJobSource ?? ""}
              onChange={(next) => setPreferences({ ...preferences, usualJobSource: next })}
              placeholder="e.g. Internet job board"
            />
          </Field>
        </div>
        <button
          onClick={() => void save("preferences", preferences)}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark"
        >
          Save application information
        </button>
      </Section>

      <Section
        title="Sensitive answer preferences"
        description="Only what you type here is ever used. Anything left blank is left for you to answer on the form."
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="Gender answer (blank declines)">
            <Text
              value={sensitive.gender ?? ""}
              onChange={(next) => setSensitive({ ...sensitive, gender: next })}
            />
          </Field>
          <Field label="Race / ethnicity answer">
            <Text
              value={sensitive.raceEthnicity ?? ""}
              onChange={(next) => setSensitive({ ...sensitive, raceEthnicity: next })}
            />
          </Field>
          <Field label="Veteran status answer">
            <Text
              value={sensitive.veteranStatus ?? ""}
              onChange={(next) => setSensitive({ ...sensitive, veteranStatus: next })}
            />
          </Field>
          <Field label="Disability status answer">
            <Text
              value={sensitive.disabilityStatus ?? ""}
              onChange={(next) => setSensitive({ ...sensitive, disabilityStatus: next })}
            />
          </Field>
          <Field label="Pronouns">
            <Text
              value={sensitive.pronouns ?? ""}
              onChange={(next) => setSensitive({ ...sensitive, pronouns: next })}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={declineDemographics}
            onChange={(event) => setDeclineDemographics(event.target.checked)}
          />
          Decline demographic questions by default
        </label>
        <button
          onClick={() => void save("sensitive", { ...sensitive, declineDemographics })}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark"
        >
          Save sensitive preferences
        </button>
      </Section>

      <ReusableAnswers answers={data.answers} onSaved={load} />
    </div>
  );
}

function EntryList({
  title,
  kind,
  entries,
  fields,
  onAdd,
  onRemove,
}: {
  title: string;
  kind: string;
  entries: Entry[];
  fields: Array<[string, string]>;
  onAdd: (body: Record<string, string>) => void;
  onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  return (
    <Section title={title} description={`Add as many entries as you need.`}>
      {entries.length > 0 && (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-start justify-between rounded-lg border border-slate-200 px-3 py-2"
            >
              <span className="text-sm text-slate-800">
                {String(entry[fields[0]![0]] ?? "")}
                {fields[1] && entry[fields[1][0]] ? ` — ${String(entry[fields[1][0]])}` : ""}
              </span>
              <button
                onClick={() => onRemove(entry.id)}
                className="text-xs text-rose-700 hover:underline"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-4">
        {fields.map(([key, label]) => (
          <Field key={key} label={label}>
            <Text
              value={draft[key] ?? ""}
              onChange={(next) => setDraft({ ...draft, [key]: next })}
            />
          </Field>
        ))}
      </div>
      <button
        onClick={() => {
          onAdd(draft);
          setDraft({});
        }}
        className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        Add {kind}
      </button>
    </Section>
  );
}

function ReusableAnswers({
  answers,
  onSaved,
}: {
  answers: Array<{ id: string; questionText: string; answer: string }>;
  onSaved: () => Promise<void>;
}) {
  const [question, setQuestion] = useState(REUSABLE_QUESTIONS[0]!);
  const [answer, setAnswer] = useState("");
  const existing = new Map(answers.map((entry) => [entry.questionText, entry]));

  return (
    <Section
      title="Approved reusable answers"
      description="Answers you have written yourself. The agent prefers these over anything it would compose."
    >
      <ul className="space-y-2">
        {REUSABLE_QUESTIONS.map((prompt) => {
          const saved = existing.get(prompt);
          return (
            <li key={prompt} className="rounded-lg border border-slate-200 px-3 py-2">
              <p className="text-sm font-medium text-slate-800">{prompt}</p>
              <p className="mt-1 text-sm text-slate-600">
                {saved ? saved.answer : <span className="italic text-slate-400">Not answered</span>}
              </p>
            </li>
          );
        })}
      </ul>
      <Field label="Question">
        <select
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          className="input w-full"
        >
          {REUSABLE_QUESTIONS.map((prompt) => (
            <option key={prompt} value={prompt}>
              {prompt}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Your answer">
        <textarea
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          rows={4}
          className="input w-full"
        />
      </Field>
      <button
        onClick={async () => {
          await fetch("/api/profile/answers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ questionText: question, answer }),
          });
          setAnswer("");
          await onSaved();
        }}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark"
      >
        Save answer
      </button>
    </Section>
  );
}
