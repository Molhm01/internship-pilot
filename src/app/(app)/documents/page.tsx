"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import CoverLetterUploader from "@/components/CoverLetterUploader";
import ApplicationAgentSettings from "@/components/ApplicationAgentSettings";
import GmailConnectionPanel from "@/components/GmailConnectionPanel";

type Bullet = { id: string; category: string; text: string; factIds: string };
type Profile = {
  fullName: string | null;
  preferredName: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  github: string | null;
  website: string | null;
  school: string | null;
  previousSchool: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressZip: string | null;
  countryOfResidence: string | null;
  willingToRelocate: boolean | null;
  locationPreferencesText: string; // comma-separated in the UI, JSON array on the wire
  internshipTermAvailability: string | null;
  salaryAnswerPreference: string | null;
  workAuthorization: string | null;
  requiresSponsorship: boolean | null;
  clearanceEligible: boolean | null;
  eeoGender: string | null;
  eeoRaceEthnicity: string | null;
  eeoVeteranStatus: string | null;
  eeoDisabilityStatus: string | null;
  legalFirstName: string | null;
  legalMiddleName: string | null;
  legalLastName: string | null;
  pronouns: string | null;
  alternateEmail: string | null;
  phoneCountryCode: string | null;
  portfolio: string | null;
  degreeType: string | null;
  educationLevel: string | null;
  major: string | null;
  minor: string | null;
  educationStartDate: string | null;
  graduationDate: string | null;
  gpa: string | null;
  gpaScale: string | null;
  relevantCourseworkText: string | null;
  remotePreference: string | null;
  earliestStartDate: string | null;
  referralSource: string | null;
  applicationEmail: string | null;
  preferredUsername: string | null;
  hasDriversLicense: boolean | null;
  meetsMinimumAge: boolean | null;
  wantsAccountCreationHelp: boolean | null;
};

const emptyProfile: Profile = {
  fullName: "",
  preferredName: "",
  email: "",
  phone: "",
  linkedin: "",
  github: "",
  website: "",
  school: "",
  previousSchool: "",
  addressStreet: "",
  addressCity: "",
  addressState: "",
  addressZip: "",
  countryOfResidence: "",
  willingToRelocate: null,
  locationPreferencesText: "",
  internshipTermAvailability: "",
  salaryAnswerPreference: "",
  workAuthorization: "",
  requiresSponsorship: null,
  clearanceEligible: null,
  eeoGender: "",
  eeoRaceEthnicity: "",
  eeoVeteranStatus: "",
  eeoDisabilityStatus: "",
  legalFirstName: "",
  legalMiddleName: "",
  legalLastName: "",
  pronouns: "",
  alternateEmail: "",
  phoneCountryCode: "",
  portfolio: "",
  degreeType: "",
  educationLevel: "",
  major: "",
  minor: "",
  educationStartDate: "",
  graduationDate: "",
  gpa: "",
  gpaScale: "",
  relevantCourseworkText: "",
  remotePreference: "",
  earliestStartDate: "",
  referralSource: "",
  applicationEmail: "",
  preferredUsername: "",
  hasDriversLicense: null,
  meetsMinimumAge: null,
  wantsAccountCreationHelp: null,
};

function triStateValue(v: boolean | null): string {
  return v === null ? "" : v ? "yes" : "no";
}
function triStateParse(s: string): boolean | null {
  return s === "" ? null : s === "yes";
}

export default function DocumentsPage() {
  const [bullets, setBullets] = useState<Bullet[]>([]);
  const [generating, setGenerating] = useState(false);
  const [genMessage, setGenMessage] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [savingProfile, setSavingProfile] = useState(false);

  const load = useCallback(async () => {
    const [bulletsRes, profileRes] = await Promise.all([
      fetch("/api/documents/bullets"),
      fetch("/api/application-profile"),
    ]);
    const bulletsData = await bulletsRes.json();
    const profileData = await profileRes.json();
    setBullets(bulletsData.bullets ?? []);
    if (profileData.profile) {
      let locationPreferencesText = "";
      let courseworkText = "";
      try {
        const parsedCoursework = profileData.profile.relevantCoursework
          ? JSON.parse(profileData.profile.relevantCoursework)
          : [];
        courseworkText = Array.isArray(parsedCoursework) ? parsedCoursework.join(", ") : "";
      } catch {
        courseworkText = "";
      }
      try {
        const parsed = profileData.profile.locationPreferences ? JSON.parse(profileData.profile.locationPreferences) : [];
        locationPreferencesText = Array.isArray(parsed) ? parsed.join(", ") : "";
      } catch {
        locationPreferencesText = "";
      }
      setProfile({
        fullName: profileData.profile.fullName ?? "",
        preferredName: profileData.profile.preferredName ?? "",
        email: profileData.profile.email ?? "",
        phone: profileData.profile.phone ?? "",
        linkedin: profileData.profile.linkedin ?? "",
        github: profileData.profile.github ?? "",
        website: profileData.profile.website ?? "",
        school: profileData.profile.school ?? "",
        previousSchool: profileData.profile.previousSchool ?? "",
        addressStreet: profileData.profile.addressStreet ?? "",
        addressCity: profileData.profile.addressCity ?? "",
        addressState: profileData.profile.addressState ?? "",
        addressZip: profileData.profile.addressZip ?? "",
        countryOfResidence: profileData.profile.countryOfResidence ?? "",
        willingToRelocate: profileData.profile.willingToRelocate ?? null,
        locationPreferencesText,
        internshipTermAvailability: profileData.profile.internshipTermAvailability ?? "",
        salaryAnswerPreference: profileData.profile.salaryAnswerPreference ?? "",
        workAuthorization: profileData.profile.workAuthorization ?? "",
        requiresSponsorship: profileData.profile.requiresSponsorship ?? null,
        clearanceEligible: profileData.profile.clearanceEligible ?? null,
        eeoGender: profileData.profile.eeoGender ?? "",
        eeoRaceEthnicity: profileData.profile.eeoRaceEthnicity ?? "",
        eeoVeteranStatus: profileData.profile.eeoVeteranStatus ?? "",
        eeoDisabilityStatus: profileData.profile.eeoDisabilityStatus ?? "",
        legalFirstName: profileData.profile.legalFirstName ?? "",
        legalMiddleName: profileData.profile.legalMiddleName ?? "",
        legalLastName: profileData.profile.legalLastName ?? "",
        pronouns: profileData.profile.pronouns ?? "",
        alternateEmail: profileData.profile.alternateEmail ?? "",
        phoneCountryCode: profileData.profile.phoneCountryCode ?? "",
        portfolio: profileData.profile.portfolio ?? "",
        degreeType: profileData.profile.degreeType ?? "",
        educationLevel: profileData.profile.educationLevel ?? "",
        major: profileData.profile.major ?? "",
        minor: profileData.profile.minor ?? "",
        educationStartDate: profileData.profile.educationStartDate ?? "",
        graduationDate: profileData.profile.graduationDate ?? "",
        gpa: profileData.profile.gpa ?? "",
        gpaScale: profileData.profile.gpaScale ?? "",
        remotePreference: profileData.profile.remotePreference ?? "",
        earliestStartDate: profileData.profile.earliestStartDate ?? "",
        referralSource: profileData.profile.referralSource ?? "",
        applicationEmail: profileData.profile.applicationEmail ?? "",
        preferredUsername: profileData.profile.preferredUsername ?? "",
        relevantCourseworkText: courseworkText,
        hasDriversLicense: profileData.profile.hasDriversLicense ?? null,
        meetsMinimumAge: profileData.profile.meetsMinimumAge ?? null,
        wantsAccountCreationHelp: profileData.profile.wantsAccountCreationHelp ?? null,
      });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function regenerateBullets() {
    setGenerating(true);
    setGenMessage(null);
    try {
      const res = await fetch("/api/documents/bullets/generate", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setGenMessage(data.error);
        return;
      }
      setGenMessage(`Generated ${data.count} bullet(s)${data.rejected ? ` (${data.rejected} rejected for lacking evidence)` : ""}.`);
      await load();
    } finally {
      setGenerating(false);
    }
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const { locationPreferencesText, relevantCourseworkText, ...rest } = profile;
      await fetch("/api/application-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...rest,
          locationPreferences: locationPreferencesText
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          relevantCoursework: (relevantCourseworkText ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
    } finally {
      setSavingProfile(false);
    }
  }

  const bulletsByCategory: Record<string, Bullet[]> = {};
  for (const b of bullets) {
    (bulletsByCategory[b.category] ??= []).push(b);
  }

  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Documents</h1>
        <p className="text-secondary text-sm">
          Your resume and its approved facts live on the{" "}
          <Link href="/profile" className="text-accent-text hover:underline">
            Profile page
          </Link>
          . Here: an optional master cover letter, your reusable bullet library, and the contact
          details used on generated documents.
        </p>
      </header>

      <CoverLetterUploader />

      <section className="bg-surface rounded-lg border border-hairline p-6 space-y-4">
        <h2 className="font-medium text-primary">Application profile (used on generated resume headers)</h2>
        <form onSubmit={saveProfile} className="grid grid-cols-2 gap-4">
          <Field label="Full (legal) name">
            <input value={profile.fullName ?? ""} onChange={(e) => setProfile({ ...profile, fullName: e.target.value })} className="input" />
          </Field>
          <Field label="Preferred name (optional)">
            <input value={profile.preferredName ?? ""} onChange={(e) => setProfile({ ...profile, preferredName: e.target.value })} className="input" />
          </Field>
          <Field label="Email">
            <input value={profile.email ?? ""} onChange={(e) => setProfile({ ...profile, email: e.target.value })} className="input" />
          </Field>
          <Field label="Phone">
            <input value={profile.phone ?? ""} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} className="input" />
          </Field>
          <Field label="Street address">
            <input value={profile.addressStreet ?? ""} onChange={(e) => setProfile({ ...profile, addressStreet: e.target.value })} className="input" />
          </Field>
          <Field label="City">
            <input value={profile.addressCity ?? ""} onChange={(e) => setProfile({ ...profile, addressCity: e.target.value })} className="input" />
          </Field>
          <Field label="State">
            <input value={profile.addressState ?? ""} onChange={(e) => setProfile({ ...profile, addressState: e.target.value })} className="input" />
          </Field>
          <Field label="ZIP">
            <input value={profile.addressZip ?? ""} onChange={(e) => setProfile({ ...profile, addressZip: e.target.value })} className="input" />
          </Field>
          <Field label="Country of residence">
            <input value={profile.countryOfResidence ?? ""} onChange={(e) => setProfile({ ...profile, countryOfResidence: e.target.value })} className="input" />
          </Field>
          <Field label="Current school (e.g. NJIT)">
            <input value={profile.school ?? ""} onChange={(e) => setProfile({ ...profile, school: e.target.value })} className="input" />
          </Field>
          <Field label="Previous school, if transferred (e.g. Stevens)">
            <input value={profile.previousSchool ?? ""} onChange={(e) => setProfile({ ...profile, previousSchool: e.target.value })} className="input" />
          </Field>
          <Field label="LinkedIn">
            <input value={profile.linkedin ?? ""} onChange={(e) => setProfile({ ...profile, linkedin: e.target.value })} className="input" />
          </Field>
          <Field label="GitHub">
            <input value={profile.github ?? ""} onChange={(e) => setProfile({ ...profile, github: e.target.value })} className="input" />
          </Field>
          <Field label="Website / portfolio">
            <input value={profile.website ?? ""} onChange={(e) => setProfile({ ...profile, website: e.target.value })} className="input" />
          </Field>
          <Field label="Legal first name">
            <input value={profile.legalFirstName ?? ""} onChange={(e) => setProfile({ ...profile, legalFirstName: e.target.value })} className="input" />
          </Field>
          <Field label="Legal middle name">
            <input value={profile.legalMiddleName ?? ""} onChange={(e) => setProfile({ ...profile, legalMiddleName: e.target.value })} className="input" />
          </Field>
          <Field label="Legal last name">
            <input value={profile.legalLastName ?? ""} onChange={(e) => setProfile({ ...profile, legalLastName: e.target.value })} className="input" />
          </Field>
          <Field label="Pronouns">
            <input value={profile.pronouns ?? ""} onChange={(e) => setProfile({ ...profile, pronouns: e.target.value })} className="input" placeholder="Left blank unless you want it answered" />
          </Field>
          <Field label="Email used for applications">
            <input value={profile.applicationEmail ?? ""} onChange={(e) => setProfile({ ...profile, applicationEmail: e.target.value })} className="input" placeholder="Defaults to your email above" />
          </Field>
          <Field label="Alternate email">
            <input value={profile.alternateEmail ?? ""} onChange={(e) => setProfile({ ...profile, alternateEmail: e.target.value })} className="input" />
          </Field>
          <Field label="Phone country code">
            <input value={profile.phoneCountryCode ?? ""} onChange={(e) => setProfile({ ...profile, phoneCountryCode: e.target.value })} className="input" placeholder="e.g. +1" />
          </Field>
          <Field label="Portfolio URL">
            <input value={profile.portfolio ?? ""} onChange={(e) => setProfile({ ...profile, portfolio: e.target.value })} className="input" />
          </Field>
          <Field label="Degree type">
            <input value={profile.degreeType ?? ""} onChange={(e) => setProfile({ ...profile, degreeType: e.target.value })} className="input" placeholder="e.g. Bachelor’s Degree" />
          </Field>
          <Field label="Education level">
            <input value={profile.educationLevel ?? ""} onChange={(e) => setProfile({ ...profile, educationLevel: e.target.value })} className="input" placeholder="e.g. Undergraduate" />
          </Field>
          <Field label="Major">
            <input value={profile.major ?? ""} onChange={(e) => setProfile({ ...profile, major: e.target.value })} className="input" />
          </Field>
          <Field label="Minor">
            <input value={profile.minor ?? ""} onChange={(e) => setProfile({ ...profile, minor: e.target.value })} className="input" />
          </Field>
          <Field label="Education start (YYYY-MM)">
            <input value={profile.educationStartDate ?? ""} onChange={(e) => setProfile({ ...profile, educationStartDate: e.target.value })} className="input" placeholder="2024-09" />
          </Field>
          <Field label="Graduation (YYYY-MM)">
            <input value={profile.graduationDate ?? ""} onChange={(e) => setProfile({ ...profile, graduationDate: e.target.value })} className="input" placeholder="2027-05" />
          </Field>
          <Field label="GPA">
            <input value={profile.gpa ?? ""} onChange={(e) => setProfile({ ...profile, gpa: e.target.value })} className="input" />
          </Field>
          <Field label="GPA scale">
            <input value={profile.gpaScale ?? ""} onChange={(e) => setProfile({ ...profile, gpaScale: e.target.value })} className="input" placeholder="e.g. 4" />
          </Field>
          <Field label="Relevant coursework (comma-separated)">
            <input value={profile.relevantCourseworkText ?? ""} onChange={(e) => setProfile({ ...profile, relevantCourseworkText: e.target.value })} className="input" />
          </Field>
          <Field label="Remote preference">
            <select value={profile.remotePreference ?? ""} onChange={(e) => setProfile({ ...profile, remotePreference: e.target.value })} className="input">
              <option value="">Ask me each time</option>
              <option value="remote">Remote</option>
              <option value="hybrid">Hybrid</option>
              <option value="onsite">On-site</option>
              <option value="no_preference">No preference</option>
            </select>
          </Field>
          <Field label="Earliest start date (YYYY-MM-DD)">
            <input value={profile.earliestStartDate ?? ""} onChange={(e) => setProfile({ ...profile, earliestStartDate: e.target.value })} className="input" placeholder="2027-06-01" />
          </Field>
          <Field label="Do you hold a valid driver’s licence?">
            <select value={triStateValue(profile.hasDriversLicense)} onChange={(e) => setProfile({ ...profile, hasDriversLicense: triStateParse(e.target.value) })} className="input">
              <option value="">Ask me each time</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </Field>
          <Field label="Do you meet the minimum age requirement?">
            <select value={triStateValue(profile.meetsMinimumAge)} onChange={(e) => setProfile({ ...profile, meetsMinimumAge: triStateParse(e.target.value) })} className="input">
              <option value="">Ask me each time</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </Field>
          <Field label="How did you hear about us?">
            <input value={profile.referralSource ?? ""} onChange={(e) => setProfile({ ...profile, referralSource: e.target.value })} className="input" placeholder="e.g. LinkedIn" />
          </Field>
          <Field label="Preferred username on employer sites">
            <input value={profile.preferredUsername ?? ""} onChange={(e) => setProfile({ ...profile, preferredUsername: e.target.value })} className="input" />
          </Field>
          <Field label="Let the agent help create employer accounts?">
            <select value={triStateValue(profile.wantsAccountCreationHelp)} onChange={(e) => setProfile({ ...profile, wantsAccountCreationHelp: triStateParse(e.target.value) })} className="input">
              <option value="">Ask me each time</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </Field>
          <Field label="Willing to relocate?">
            <select
              value={triStateValue(profile.willingToRelocate)}
              onChange={(e) => setProfile({ ...profile, willingToRelocate: triStateParse(e.target.value) })}
              className="input"
            >
              <option value="">Ask me each time</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </Field>
          <Field label="Location preferences (comma-separated)">
            <input
              value={profile.locationPreferencesText}
              onChange={(e) => setProfile({ ...profile, locationPreferencesText: e.target.value })}
              placeholder="e.g. Remote, New Jersey, New York"
              className="input"
            />
          </Field>
          <Field label="Internship-term availability">
            <input
              value={profile.internshipTermAvailability ?? ""}
              onChange={(e) => setProfile({ ...profile, internshipTermAvailability: e.target.value })}
              placeholder="e.g. Summer 2027"
              className="input"
            />
          </Field>
          <Field label="Salary-answer preference">
            <input
              value={profile.salaryAnswerPreference ?? ""}
              onChange={(e) => setProfile({ ...profile, salaryAnswerPreference: e.target.value })}
              placeholder="e.g. Negotiable"
              className="input"
            />
          </Field>
          <div className="col-span-2">
            <button
              type="submit"
              disabled={savingProfile}
              className="rounded-lg bg-accent text-white text-sm font-medium px-4 py-2.5 disabled:opacity-40 hover:bg-accent-dark transition-colors"
            >
              {savingProfile ? "Saving…" : "Save profile"}
            </button>
          </div>
        </form>
      </section>

      <section className="bg-surface rounded-lg border border-hairline p-6 space-y-4">
        <h2 className="font-medium text-primary">Application-form answers (optional)</h2>
        <p className="text-xs text-tertiary">
          Leave any of these blank and the Application Agent will always stop and ask you directly
          instead of guessing — it never invents an answer to a work-authorization, sponsorship,
          clearance, or demographic question.
        </p>
        <form onSubmit={saveProfile} className="grid grid-cols-2 gap-4">
          <Field label="Work authorization (e.g. U.S. Citizen, F-1 OPT/CPT)">
            <input
              value={profile.workAuthorization ?? ""}
              onChange={(e) => setProfile({ ...profile, workAuthorization: e.target.value })}
              className="input"
            />
          </Field>
          <Field label="Do you require visa sponsorship?">
            <select
              value={triStateValue(profile.requiresSponsorship)}
              onChange={(e) => setProfile({ ...profile, requiresSponsorship: triStateParse(e.target.value) })}
              className="input"
            >
              <option value="">Ask me each time</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </Field>
          <Field label="Eligible for security clearance?">
            <select
              value={triStateValue(profile.clearanceEligible)}
              onChange={(e) => setProfile({ ...profile, clearanceEligible: triStateParse(e.target.value) })}
              className="input"
            >
              <option value="">Ask me each time</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </Field>
          <div />
          <Field label="Gender (EEO, optional)">
            <input value={profile.eeoGender ?? ""} onChange={(e) => setProfile({ ...profile, eeoGender: e.target.value })} className="input" />
          </Field>
          <Field label="Race/ethnicity (EEO, optional)">
            <input value={profile.eeoRaceEthnicity ?? ""} onChange={(e) => setProfile({ ...profile, eeoRaceEthnicity: e.target.value })} className="input" />
          </Field>
          <Field label="Veteran status (EEO, optional)">
            <input value={profile.eeoVeteranStatus ?? ""} onChange={(e) => setProfile({ ...profile, eeoVeteranStatus: e.target.value })} className="input" />
          </Field>
          <Field label="Disability status (EEO, optional)">
            <input value={profile.eeoDisabilityStatus ?? ""} onChange={(e) => setProfile({ ...profile, eeoDisabilityStatus: e.target.value })} className="input" />
          </Field>
          <div className="col-span-2">
            <button
              type="submit"
              disabled={savingProfile}
              className="rounded-lg bg-accent text-white text-sm font-medium px-4 py-2.5 disabled:opacity-40 hover:bg-accent-dark transition-colors"
            >
              {savingProfile ? "Saving…" : "Save answers"}
            </button>
          </div>
        </form>
      </section>

      <ApplicationAgentSettings />

      <GmailConnectionPanel />

      <section className="bg-surface rounded-lg border border-hairline p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-primary">Bullet library ({bullets.length})</h2>
          <button
            onClick={regenerateBullets}
            disabled={generating}
            className="rounded-lg bg-accent text-white text-sm font-medium px-4 py-2 disabled:opacity-40 hover:bg-accent-dark transition-colors"
          >
            {generating ? "Generating…" : "Regenerate from approved facts"}
          </button>
        </div>
        <p className="text-xs text-tertiary">
          Every bullet below is grounded in specific approved resume facts and is only ever
          <em> selected</em> (never rewritten) when tailoring a resume for a job — this is what
          guarantees nothing gets invented per application.
        </p>
        {genMessage && <p className="text-xs text-secondary">{genMessage}</p>}
        {bullets.length === 0 ? (
          <p className="text-sm text-tertiary">No bullets yet. Approve resume facts on the Profile page, then click Regenerate.</p>
        ) : (
          <div className="space-y-4">
            {Object.entries(bulletsByCategory).map(([category, items]) => (
              <div key={category}>
                <h3 className="text-xs uppercase tracking-wide font-semibold text-tertiary mb-2">{category}</h3>
                <div className="space-y-1.5">
                  {items.map((b) => (
                    <div key={b.id} className="text-sm text-secondary border border-hairline rounded-lg px-3 py-2">
                      {b.text}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-secondary">{label}</span>
      {children}
    </label>
  );
}
