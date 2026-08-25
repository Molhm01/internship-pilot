"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The canonical application profile, edited in one place.
 *
 * Every control here writes to the single `ApplicationProfile` row that the
 * extension's bundle is built from, so what the user sees is exactly what an
 * employer form will be filled with.
 *
 * Two rules the UI has to make visible rather than merely obey:
 *
 * 1. Blank means unanswerable. Nothing on this page has a placeholder that
 *    doubles as a default, and every tri-state control offers a real "not
 *    answered" option rather than defaulting to No.
 * 2. Sensitive and consent questions are opt-in. They start unanswered and stay
 *    that way until the user picks something.
 */

type Profile = Record<string, unknown>;

// Every field below is either PERSISTED (backed by a real column, saved by
// POST /api/application-profile), or explicitly marked `persisted: false`
// with a `hint` explaining why — never editable-and-silently-discarded. A
// `persisted: false` field renders disabled: there is nothing to type into,
// so there is nothing Save can lose. applicationProfileForUser() (the same
// projection this form loads) already returns `null` for every one of these,
// which is the other half of the same contract.
const TEXT_FIELD_GROUPS: ReadonlyArray<{
  title: string;
  hint?: string;
  fields: ReadonlyArray<{ name: string; label: string; hint?: string; type?: string; persisted?: false }>;
}> = [
  {
    title: "Legal name",
    hint: "What the application asks for, not what your résumé header says.",
    fields: [
      { name: "legalFirstName", label: "Legal first name" },
      { name: "legalMiddleName", label: "Legal middle name" },
      { name: "legalLastName", label: "Legal last name" },
      { name: "suffix", label: "Suffix", hint: "Not saved yet — no storage field exists for a name suffix.", persisted: false },
      { name: "preferredName", label: "Preferred name" },
      { name: "fullName", label: "Full name on generated documents", hint: "Built automatically from your legal first and last name above.", persisted: false },
    ],
  },
  {
    title: "Contact",
    fields: [
      { name: "applicationEmail", label: "Application email", hint: "Used to register on employer sites. Authoritative over Everyday email below." },
      { name: "email", label: "Everyday email", hint: "Not stored separately — used only to fill Application email above if you leave it blank." },
      { name: "alternateEmail", label: "Alternate email" },
      { name: "phoneCountryCode", label: "Phone country code" },
      { name: "phone", label: "Phone number" },
    ],
  },
  {
    title: "Address",
    fields: [
      { name: "addressStreet", label: "Address line 1" },
      { name: "addressLine2", label: "Address line 2", hint: "Leave empty if you have none — it is never filled with a copy of line 1" },
      { name: "addressCity", label: "City" },
      { name: "addressState", label: "State / province" },
      { name: "addressZip", label: "Postal code" },
      { name: "countryOfResidence", label: "Country" },
      { name: "metroRegion", label: "Closest metropolitan region", hint: "Not saved yet — no storage field exists for a separate metro region.", persisted: false },
    ],
  },
  {
    title: "Links",
    fields: [
      { name: "linkedin", label: "LinkedIn" },
      { name: "github", label: "GitHub" },
      { name: "portfolio", label: "Portfolio", hint: "Authoritative over Personal website below when both are filled in." },
      { name: "website", label: "Personal website", hint: "Not stored separately — used only to fill Portfolio above if you leave it blank." },
    ],
  },
  {
    title: "Education",
    hint: "Edits your primary/current education entry. Add additional entries on the Education page.",
    fields: [
      { name: "school", label: "School" },
      { name: "previousSchool", label: "Previous school", hint: "Add a second entry on the Education page instead — this form edits only your primary entry.", persisted: false },
      { name: "degreeType", label: "Degree currently pursuing" },
      { name: "highestDegreeAwarded", label: "Highest degree already awarded", hint: "Not saved yet — only one \"degree\" field exists per education entry.", persisted: false },
      { name: "educationLevel", label: "Education level" },
      { name: "major", label: "Major" },
      { name: "minor", label: "Minor" },
      { name: "educationStartDate", label: "Start month/year", hint: "YYYY-MM" },
      { name: "graduationDate", label: "Graduation month/year", hint: "YYYY-MM" },
      { name: "gpa", label: "GPA", hint: "Include the scale if it isn't out of 4.0, e.g. \"3.8/4.0\"." },
      { name: "gpaScale", label: "GPA scale", hint: "Not saved yet — include the scale in GPA above instead.", persisted: false },
    ],
  },
  {
    title: "Availability and compensation",
    fields: [
      { name: "earliestStartDate", label: "Earliest available date", hint: "YYYY-MM-DD" },
      { name: "internshipTermAvailability", label: "Availability term", hint: "Not saved yet — no storage field exists for a separate availability term.", persisted: false },
      { name: "salaryMinimum", label: "Salary minimum", hint: "Not saved yet — state a figure in \"Salary answer used verbatim\" below instead.", persisted: false },
      { name: "salaryAnswerPreference", label: "Salary answer used verbatim" },
      { name: "securityClearanceStatus", label: "Security clearance status" },
      { name: "referralSource", label: "How you usually hear about jobs", hint: 'Answers "How did you hear about us?"' },
      { name: "preferredUsername", label: "Preferred username on employer sites", hint: "Not saved yet — no storage field exists for a preferred username.", persisted: false },
    ],
  },
];

const SELECT_FIELDS: ReadonlyArray<{
  name: string;
  label: string;
  hint?: string;
  persisted?: false;
  options: ReadonlyArray<{ value: string; label: string }>;
}> = [
  {
    name: "preferredWebsiteField",
    label: "Which link answers a single “Website” box",
    hint: "Not saved yet — no storage field exists for this preference.",
    persisted: false,
    options: [
      { value: "", label: "Not answered" },
      { value: "linkedin", label: "LinkedIn" },
      { value: "github", label: "GitHub" },
      { value: "portfolio", label: "Portfolio" },
      { value: "website", label: "Personal website" },
    ],
  },
  {
    name: "remotePreference",
    label: "Remote preference",
    options: [
      { value: "", label: "Not answered" },
      { value: "remote", label: "Remote" },
      { value: "hybrid", label: "Hybrid" },
      { value: "onsite", label: "On site" },
      { value: "no_preference", label: "No preference" },
    ],
  },
  {
    name: "salaryStrategy",
    label: "Salary strategy",
    hint: "Not saved yet — express this in \"Salary answer used verbatim\" instead.",
    persisted: false,
    options: [
      { value: "", label: "Not answered" },
      { value: "negotiable", label: "Say it is negotiable" },
      { value: "specific", label: "Give the figure above" },
      { value: "decline", label: "Decline to state" },
    ],
  },
  {
    name: "employerPortalStrategy",
    label: "Employer portal strategy",
    hint: "Not saved yet — no storage field exists for this preference.",
    persisted: false,
    options: [
      { value: "", label: "Always ask me" },
      { value: "prefer_guest", label: "Prefer applying as a guest" },
      { value: "create_when_required", label: "Create an account when one is required" },
      { value: "always_ask", label: "Always ask me" },
    ],
  },
];

const TRISTATE_FIELDS: ReadonlyArray<{ name: string; label: string; hint?: string; persisted?: false }> = [
  // An explicit tri-state, never inferred from free text — this directly
  // answers the legal question ApplicationPreferences.legallyAuthorizedToWork
  // stores. There is deliberately no free-text "Work authorization" box
  // anywhere in this form; the human-readable version of this answer is
  // derived read-only, from this field, by applicationProfileForUser().
  { name: "legallyAuthorizedToWork", label: "Legally authorized to work in the United States?" },
  { name: "willingToRelocate", label: "Willing to relocate" },
  { name: "requiresSponsorship", label: "Requires visa sponsorship" },
  { name: "clearanceEligible", label: "Eligible for a security clearance", hint: "Not saved yet — use the Security clearance status text field instead.", persisted: false },
  { name: "hasDriversLicense", label: "Has a driver's licence" },
  { name: "meetsMinimumAge", label: "Meets the minimum age", hint: "Not saved yet — no storage field exists for this answer.", persisted: false },
  { name: "noMiddleName", label: "I have no middle name", hint: "Not saved yet — leaving Legal middle name blank is currently indistinguishable from not answering.", persisted: false },
  {
    name: "marketingTextConsent",
    label: "Consents to promotional text messages",
    hint: "Not saved yet — no storage field exists for this consent.",
    persisted: false,
  },
  {
    name: "wantsAccountCreationHelp",
    label: "Let the extension help create employer accounts",
    hint: "Not saved yet — the extension still asks for one explicit confirmation before it creates anything.",
    persisted: false,
  },
];

const SENSITIVE_FIELDS: ReadonlyArray<{ name: string; label: string }> = [
  { name: "eeoGender", label: "Gender" },
  { name: "eeoRaceEthnicity", label: "Race / ethnicity" },
  { name: "eeoVeteranStatus", label: "Veteran status" },
  { name: "eeoDisabilityStatus", label: "Disability status" },
  { name: "pronouns", label: "Pronouns" },
];

const LIST_FIELDS: ReadonlyArray<{ name: string; label: string; hint: string; persisted?: false }> = [
  { name: "locationPreferences", label: "Preferred locations", hint: "Not saved yet — no storage field exists for this list.", persisted: false },
  { name: "relevantCoursework", label: "Relevant coursework", hint: "Comma separated. Saved to your primary education entry." },
];

function stringValue(profile: Profile, name: string): string {
  const value = profile[name];
  return typeof value === "string" ? value : "";
}

function listValue(profile: Profile, name: string): string {
  const value = profile[name];
  if (typeof value !== "string" || !value) return "";
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e === "string").join(", ") : "";
  } catch {
    return "";
  }
}

function triValue(profile: Profile, name: string): string {
  const value = profile[name];
  return typeof value === "boolean" ? (value ? "yes" : "no") : "";
}

// Every persisted field this form submits, by how it round-trips through the
// server. "email" and "website" are deliberately excluded — they are
// fallback-only sources for applicationEmail/portfolio (see the API route),
// not independently persisted, so they would never equal what comes back.
const TEXT_COMPARE_FIELDS = TEXT_FIELD_GROUPS.flatMap((group) => group.fields)
  .filter((field) => field.persisted !== false && field.name !== "email" && field.name !== "website")
  .map((field) => field.name);
const SELECT_COMPARE_FIELDS = SELECT_FIELDS.filter((field) => field.persisted !== false).map((field) => field.name);
const TRISTATE_COMPARE_FIELDS = TRISTATE_FIELDS.filter((field) => field.persisted !== false).map((field) => field.name);
const LIST_COMPARE_FIELDS = LIST_FIELDS.filter((field) => field.persisted !== false).map((field) => field.name);

/**
 * True only when every field this form actually submitted for persistence
 * comes back unchanged from the server. This is what catches a save that
 * returned 200 against a server already mid-restart, or any other silent
 * partial write — a case a bare `response.ok` check cannot see, and exactly
 * the failure mode that let a real profile save go unnoticed.
 */
function submittedFieldsPersisted(submitted: Profile, persisted: Profile): string[] {
  const mismatches: string[] = [];
  for (const name of [...TEXT_COMPARE_FIELDS, ...SELECT_COMPARE_FIELDS]) {
    if (stringValue(submitted, name).trim() !== stringValue(persisted, name).trim()) mismatches.push(name);
  }
  for (const name of TRISTATE_COMPARE_FIELDS) {
    if (triValue(submitted, name) !== triValue(persisted, name)) mismatches.push(name);
  }
  for (const name of LIST_COMPARE_FIELDS) {
    if (listValue(submitted, name) !== listValue(persisted, name)) mismatches.push(name);
  }
  return mismatches;
}

export default function CanonicalProfileForm() {
  const [profile, setProfile] = useState<Profile>({});
  const [gaps, setGaps] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/application-profile");
      if (!response.ok) throw new Error("The profile could not be read.");
      const data = (await response.json()) as { profile: Profile | null; gaps?: string[] };
      setProfile(data.profile ?? {});
      setGaps(data.gaps ?? []);
      setStatus("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function set(name: string, value: unknown) {
    setProfile((current) => ({ ...current, [name]: value }));
    setStatus("idle");
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setStatus("saving");
    setError(null);
    // Snapshot exactly what is being submitted, before any server round trip,
    // so it can be checked against what the server reports back as persisted.
    const submitted = profile;
    try {
      const body: Record<string, unknown> = { ...profile };
      // Lists travel as arrays; the server is what turns them back into JSON.
      for (const field of LIST_FIELDS) {
        body[field.name] = listValue(profile, field.name)
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
      }
      const response = await fetch("/api/application-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("The profile could not be saved. Nothing was changed.");
      // The save response already carries the freshly persisted projection —
      // reading it back (rather than trusting the 200 alone) is what proves
      // the write actually landed, not merely that a request was accepted.
      const data = (await response.json()) as { profile: Profile | null; gaps?: string[] };
      const persisted = data.profile ?? {};
      const mismatches = submittedFieldsPersisted(submitted, persisted);
      if (mismatches.length > 0) {
        throw new Error(
          `Save did not take effect for: ${mismatches.join(", ")}. Please retry — nothing was confirmed saved.`,
        );
      }
      setProfile(persisted);
      setGaps(data.gaps ?? []);
      setStatus("saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  }

  if (status === "loading") {
    return <p className="text-sm text-tertiary">Loading your profile…</p>;
  }

  return (
    <form onSubmit={save} className="space-y-8">
      {gaps.length > 0 ? (
        <div className="rounded-lg border border-caution-line bg-caution-quiet p-4">
          <p className="text-sm font-medium text-amber-900">
            An employer form cannot be completed from this profile yet.
          </p>
          <ul className="mt-2 list-disc pl-5 text-sm text-caution">
            {gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {TEXT_FIELD_GROUPS.map((group) => (
        <section key={group.title} className="rounded-lg border border-hairline bg-surface p-6">
          <h2 className="font-medium text-primary">{group.title}</h2>
          {group.hint ? <p className="mt-1 text-sm text-tertiary">{group.hint}</p> : null}
          <div className="mt-4 grid grid-cols-2 gap-4">
            {group.fields.map((field) => (
              <label key={field.name} className="block text-sm">
                <span className="text-secondary">{field.label}</span>
                <input
                  name={field.name}
                  type={field.type ?? "text"}
                  value={stringValue(profile, field.name)}
                  onChange={(event) => set(field.name, event.target.value)}
                  disabled={field.persisted === false}
                  className="input mt-1 w-full disabled:cursor-not-allowed disabled:opacity-60"
                />
                {field.hint ? (
                  <span className={`mt-1 block text-xs ${field.persisted === false ? "text-caution" : "text-tertiary"}`}>
                    {field.hint}
                  </span>
                ) : null}
              </label>
            ))}
          </div>
        </section>
      ))}

      <section className="rounded-lg border border-hairline bg-surface p-6">
        <h2 className="font-medium text-primary">Application preferences</h2>
        <div className="mt-4 grid grid-cols-2 gap-4">
          {SELECT_FIELDS.map((field) => (
            <label key={field.name} className="block text-sm">
              <span className="text-secondary">{field.label}</span>
              <select
                name={field.name}
                value={stringValue(profile, field.name)}
                onChange={(event) => set(field.name, event.target.value)}
                disabled={field.persisted === false}
                className="input mt-1 w-full disabled:cursor-not-allowed disabled:opacity-60"
              >
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {field.hint ? (
                <span className={`mt-1 block text-xs ${field.persisted === false ? "text-caution" : "text-tertiary"}`}>
                  {field.hint}
                </span>
              ) : null}
            </label>
          ))}
          {LIST_FIELDS.map((field) => (
            <label key={field.name} className="block text-sm">
              <span className="text-secondary">{field.label}</span>
              <input
                name={field.name}
                value={listValue(profile, field.name)}
                onChange={(event) =>
                  set(
                    field.name,
                    JSON.stringify(
                      event.target.value
                        .split(",")
                        .map((entry) => entry.trim())
                        .filter(Boolean),
                    ),
                  )
                }
                disabled={field.persisted === false}
                className="input mt-1 w-full disabled:cursor-not-allowed disabled:opacity-60"
              />
              <span className={`mt-1 block text-xs ${field.persisted === false ? "text-caution" : "text-tertiary"}`}>
                {field.hint}
              </span>
            </label>
          ))}
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4">
          {TRISTATE_FIELDS.map((field) => (
            <label key={field.name} className="block text-sm">
              <span className="text-secondary">{field.label}</span>
              <select
                name={field.name}
                value={triValue(profile, field.name)}
                onChange={(event) =>
                  set(field.name, event.target.value === "" ? null : event.target.value === "yes")
                }
                disabled={field.persisted === false}
                className="input mt-1 w-full disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">Not answered</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
              {field.hint ? (
                <span className={`mt-1 block text-xs ${field.persisted === false ? "text-caution" : "text-tertiary"}`}>
                  {field.hint}
                </span>
              ) : null}
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-hairline bg-surface p-6">
        <h2 className="font-medium text-primary">Sensitive questions</h2>
        <p className="mt-1 text-sm text-tertiary">
          Only what you type here is ever disclosed. Left empty, the agent leaves the question for
          you rather than answering it — including declining on your behalf.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-4">
          {SENSITIVE_FIELDS.map((field) => (
            <label key={field.name} className="block text-sm">
              <span className="text-secondary">{field.label}</span>
              <input
                name={field.name}
                value={stringValue(profile, field.name)}
                onChange={(event) => set(field.name, event.target.value)}
                placeholder="Not answered"
                className="input mt-1 w-full"
              />
            </label>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={status === "saving"}
          className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {status === "saving" ? "Saving…" : "Save profile"}
        </button>
        {status === "saved" ? <span className="text-sm text-verified">Saved.</span> : null}
        {error ? <span className="text-sm text-critical">{error}</span> : null}
      </div>
    </form>
  );
}
