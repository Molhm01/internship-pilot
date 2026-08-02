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

const TEXT_FIELD_GROUPS: ReadonlyArray<{
  title: string;
  hint?: string;
  fields: ReadonlyArray<{ name: string; label: string; hint?: string; type?: string }>;
}> = [
  {
    title: "Legal name",
    hint: "What the application asks for, not what your résumé header says.",
    fields: [
      { name: "legalFirstName", label: "Legal first name" },
      { name: "legalMiddleName", label: "Legal middle name" },
      { name: "legalLastName", label: "Legal last name" },
      { name: "suffix", label: "Suffix", hint: "Jr., III, and so on" },
      { name: "preferredName", label: "Preferred name" },
      { name: "fullName", label: "Full name on generated documents" },
    ],
  },
  {
    title: "Contact",
    fields: [
      { name: "applicationEmail", label: "Application email", hint: "Used to register on employer sites" },
      { name: "email", label: "Everyday email" },
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
      { name: "metroRegion", label: "Closest metropolitan region", hint: "Overrides your city when a form asks for a metro area" },
    ],
  },
  {
    title: "Links",
    fields: [
      { name: "linkedin", label: "LinkedIn" },
      { name: "github", label: "GitHub" },
      { name: "portfolio", label: "Portfolio" },
      { name: "website", label: "Personal website" },
    ],
  },
  {
    title: "Education",
    fields: [
      { name: "school", label: "School" },
      { name: "previousSchool", label: "Previous school" },
      { name: "degreeType", label: "Degree currently pursuing" },
      { name: "highestDegreeAwarded", label: "Highest degree already awarded", hint: "A different question from the one above" },
      { name: "educationLevel", label: "Education level" },
      { name: "major", label: "Major" },
      { name: "minor", label: "Minor" },
      { name: "educationStartDate", label: "Start month/year", hint: "YYYY-MM" },
      { name: "graduationDate", label: "Graduation month/year", hint: "YYYY-MM" },
      { name: "gpa", label: "GPA" },
      { name: "gpaScale", label: "GPA scale" },
    ],
  },
  {
    title: "Availability and compensation",
    fields: [
      { name: "earliestStartDate", label: "Earliest available date", hint: "YYYY-MM-DD" },
      { name: "internshipTermAvailability", label: "Availability term", hint: 'e.g. "Summer 2027"' },
      { name: "salaryMinimum", label: "Salary minimum" },
      { name: "salaryAnswerPreference", label: "Salary answer used verbatim" },
      { name: "workAuthorization", label: "Work authorization" },
      { name: "securityClearanceStatus", label: "Security clearance status" },
      { name: "referralSource", label: "How you usually hear about jobs", hint: 'Answers "How did you hear about us?"' },
      { name: "preferredUsername", label: "Preferred username on employer sites" },
    ],
  },
];

const SELECT_FIELDS: ReadonlyArray<{
  name: string;
  label: string;
  hint?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}> = [
  {
    name: "preferredWebsiteField",
    label: "Which link answers a single “Website” box",
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
    hint: "What to do when an employer site wants a login before the application",
    options: [
      { value: "", label: "Always ask me" },
      { value: "prefer_guest", label: "Prefer applying as a guest" },
      { value: "create_when_required", label: "Create an account when one is required" },
      { value: "always_ask", label: "Always ask me" },
    ],
  },
];

const TRISTATE_FIELDS: ReadonlyArray<{ name: string; label: string; hint?: string }> = [
  { name: "willingToRelocate", label: "Willing to relocate" },
  { name: "requiresSponsorship", label: "Requires visa sponsorship" },
  { name: "clearanceEligible", label: "Eligible for a security clearance" },
  { name: "hasDriversLicense", label: "Has a driver's licence" },
  { name: "meetsMinimumAge", label: "Meets the minimum age" },
  { name: "noMiddleName", label: "I have no middle name" },
  {
    name: "marketingTextConsent",
    label: "Consents to promotional text messages",
    hint: "Never assumed. Left unanswered, the box stays unchecked.",
  },
  {
    name: "wantsAccountCreationHelp",
    label: "Let the extension help create employer accounts",
    hint: "The extension still asks for one explicit confirmation before it creates anything.",
  },
];

const SENSITIVE_FIELDS: ReadonlyArray<{ name: string; label: string }> = [
  { name: "eeoGender", label: "Gender" },
  { name: "eeoRaceEthnicity", label: "Race / ethnicity" },
  { name: "eeoVeteranStatus", label: "Veteran status" },
  { name: "eeoDisabilityStatus", label: "Disability status" },
  { name: "pronouns", label: "Pronouns" },
];

const LIST_FIELDS: ReadonlyArray<{ name: string; label: string; hint: string }> = [
  { name: "locationPreferences", label: "Preferred locations", hint: "Comma separated" },
  { name: "relevantCoursework", label: "Relevant coursework", hint: "Comma separated" },
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
      if (!response.ok) throw new Error("The profile could not be saved.");
      await load();
      setStatus("saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  }

  if (status === "loading") {
    return <p className="text-sm text-slate-500">Loading your profile…</p>;
  }

  return (
    <form onSubmit={save} className="space-y-8">
      {gaps.length > 0 ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            An employer form cannot be completed from this profile yet.
          </p>
          <ul className="mt-2 list-disc pl-5 text-sm text-amber-800">
            {gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {TEXT_FIELD_GROUPS.map((group) => (
        <section key={group.title} className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="font-medium text-slate-900">{group.title}</h2>
          {group.hint ? <p className="mt-1 text-sm text-slate-500">{group.hint}</p> : null}
          <div className="mt-4 grid grid-cols-2 gap-4">
            {group.fields.map((field) => (
              <label key={field.name} className="block text-sm">
                <span className="text-slate-700">{field.label}</span>
                <input
                  name={field.name}
                  type={field.type ?? "text"}
                  value={stringValue(profile, field.name)}
                  onChange={(event) => set(field.name, event.target.value)}
                  className="input mt-1 w-full"
                />
                {field.hint ? (
                  <span className="mt-1 block text-xs text-slate-500">{field.hint}</span>
                ) : null}
              </label>
            ))}
          </div>
        </section>
      ))}

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="font-medium text-slate-900">Application preferences</h2>
        <div className="mt-4 grid grid-cols-2 gap-4">
          {SELECT_FIELDS.map((field) => (
            <label key={field.name} className="block text-sm">
              <span className="text-slate-700">{field.label}</span>
              <select
                name={field.name}
                value={stringValue(profile, field.name)}
                onChange={(event) => set(field.name, event.target.value)}
                className="input mt-1 w-full"
              >
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {field.hint ? (
                <span className="mt-1 block text-xs text-slate-500">{field.hint}</span>
              ) : null}
            </label>
          ))}
          {LIST_FIELDS.map((field) => (
            <label key={field.name} className="block text-sm">
              <span className="text-slate-700">{field.label}</span>
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
                className="input mt-1 w-full"
              />
              <span className="mt-1 block text-xs text-slate-500">{field.hint}</span>
            </label>
          ))}
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4">
          {TRISTATE_FIELDS.map((field) => (
            <label key={field.name} className="block text-sm">
              <span className="text-slate-700">{field.label}</span>
              <select
                name={field.name}
                value={triValue(profile, field.name)}
                onChange={(event) =>
                  set(field.name, event.target.value === "" ? null : event.target.value === "yes")
                }
                className="input mt-1 w-full"
              >
                <option value="">Not answered</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
              {field.hint ? (
                <span className="mt-1 block text-xs text-slate-500">{field.hint}</span>
              ) : null}
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="font-medium text-slate-900">Sensitive questions</h2>
        <p className="mt-1 text-sm text-slate-500">
          Only what you type here is ever disclosed. Left empty, the agent leaves the question for
          you rather than answering it — including declining on your behalf.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-4">
          {SENSITIVE_FIELDS.map((field) => (
            <label key={field.name} className="block text-sm">
              <span className="text-slate-700">{field.label}</span>
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
          className="rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {status === "saving" ? "Saving…" : "Save profile"}
        </button>
        {status === "saved" ? <span className="text-sm text-emerald-700">Saved.</span> : null}
        {error ? <span className="text-sm text-red-700">{error}</span> : null}
      </div>
    </form>
  );
}
