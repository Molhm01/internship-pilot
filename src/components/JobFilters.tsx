"use client";

import { useEffect, useState } from "react";
import { DISCIPLINE_TAGS, DisciplineTag } from "@/lib/sync/classify";
import { TRACKER_STATUSES } from "@/lib/statuses";

export type JobFiltersState = {
  availability: string; // "" = active feed (default) | official | source_listed | verification_pending | closed | security | all
  location: string;
  status: string;
  internshipTerm: string;
  duration: string;
  postingDateFrom: string;
  postingDateTo: string;
  lastVerifiedFrom: string;
  lastVerifiedTo: string;
  workplaceType: string;
  season: string;
  maxDistanceMiles: string;
  includeRemoteRegardlessOfDistance: boolean;
  relocationWillingness: boolean;
  disciplines: DisciplineTag[];
  sophomoreEligible: string;
  graduationYear: string;
  sponsorship: string;
  citizenshipOrClearance: string;
  compMin: string;
  matchScoreMin: string;
};

export const EMPTY_FILTERS: JobFiltersState = {
  availability: "",
  location: "",
  status: "",
  internshipTerm: "",
  duration: "",
  postingDateFrom: "",
  postingDateTo: "",
  lastVerifiedFrom: "",
  lastVerifiedTo: "",
  workplaceType: "",
  season: "",
  maxDistanceMiles: "",
  includeRemoteRegardlessOfDistance: false,
  relocationWillingness: true,
  disciplines: [],
  sophomoreEligible: "",
  graduationYear: "",
  sponsorship: "",
  citizenshipOrClearance: "",
  compMin: "",
  matchScoreMin: "",
};

const DISCIPLINE_LABELS: Record<DisciplineTag, string> = {
  electrical: "Electrical",
  computerEngineering: "Computer Engineering",
  hardware: "Hardware",
  embedded: "Embedded systems",
  electronics: "Electronics",
  test: "Test engineering",
  manufacturing: "Manufacturing",
  semiconductor: "Semiconductor",
  fpga: "FPGA / Digital Hardware",
  controls: "Controls & automation",
  robotics: "Robotics",
  systemsEngineering: "Systems Engineering",
  engineeringTechnician: "Engineering Technician",
  fieldApplications: "Field Applications",
  firmware: "Firmware",
};

const AVAILABILITY_QUERY: Record<string, (p: URLSearchParams) => void> = {
  "": () => {}, // default: feed=active
  official: (p) => p.set("verificationStatus", "VERIFIED_OFFICIAL_AT_LAST_CHECK"),
  source_listed: (p) => p.set("verificationStatus", "ACTIVE_SOURCE_LISTED"),
  verification_pending: (p) => p.set("verificationStatus", "VERIFICATION_PENDING,Pending,NeedsReview"),
  closed: (p) => p.set("verificationStatus", "Closed"),
  security: (p) => p.set("verificationStatus", "SecurityQuarantine"),
  all: (p) => p.set("feed", "all"),
};

export function buildJobsQuery(filters: JobFiltersState): URLSearchParams {
  const params = new URLSearchParams();
  (AVAILABILITY_QUERY[filters.availability] ?? AVAILABILITY_QUERY[""])(params);
  if (filters.location) params.set("location", filters.location);
  if (filters.status) params.set("status", filters.status);
  if (filters.internshipTerm) params.set("internshipTerm", filters.internshipTerm);
  if (filters.duration) params.set("duration", filters.duration);
  if (filters.postingDateFrom) params.set("postingDateFrom", filters.postingDateFrom);
  if (filters.postingDateTo) params.set("postingDateTo", filters.postingDateTo);
  if (filters.lastVerifiedFrom) params.set("lastVerifiedFrom", filters.lastVerifiedFrom);
  if (filters.lastVerifiedTo) params.set("lastVerifiedTo", filters.lastVerifiedTo);
  if (filters.workplaceType) params.set("workplaceType", filters.workplaceType);
  if (filters.season) params.set("season", filters.season);
  if (!filters.relocationWillingness && filters.maxDistanceMiles) {
    params.set("maxDistanceMiles", filters.maxDistanceMiles);
    if (filters.includeRemoteRegardlessOfDistance) {
      params.set("includeRemoteRegardlessOfDistance", "true");
    }
  }
  if (filters.disciplines.length > 0) params.set("disciplines", filters.disciplines.join(","));
  if (filters.sophomoreEligible) params.set("sophomoreEligible", filters.sophomoreEligible);
  if (filters.graduationYear) params.set("graduationYear", filters.graduationYear);
  if (filters.sponsorship) params.set("sponsorship", filters.sponsorship);
  if (filters.citizenshipOrClearance) params.set("citizenshipOrClearance", filters.citizenshipOrClearance);
  if (filters.compMin) params.set("compMin", filters.compMin);
  if (filters.matchScoreMin) params.set("matchScoreMin", filters.matchScoreMin);
  return params;
}

type SavedFilter = { id: string; name: string; filterJson: string };

export default function JobFilters({
  filters,
  onChange,
}: {
  filters: JobFiltersState;
  onChange: (f: JobFiltersState) => void;
}) {
  const [presets, setPresets] = useState<SavedFilter[]>([]);

  useEffect(() => {
    fetch("/api/filters/saved")
      .then((r) => r.json())
      .then((data) => setPresets(data.filters ?? []))
      .catch(() => {});
  }, []);

  function set<K extends keyof JobFiltersState>(key: K, value: JobFiltersState[K]) {
    onChange({ ...filters, [key]: value });
  }

  function toggleDiscipline(tag: DisciplineTag) {
    const has = filters.disciplines.includes(tag);
    set("disciplines", has ? filters.disciplines.filter((d) => d !== tag) : [...filters.disciplines, tag]);
  }

  function applyPreset(preset: SavedFilter) {
    const parsed = JSON.parse(preset.filterJson);
    onChange({
      ...EMPTY_FILTERS,
      disciplines: parsed.disciplines ?? [],
      maxDistanceMiles: parsed.maxDistanceMiles ? String(parsed.maxDistanceMiles) : "",
      includeRemoteRegardlessOfDistance: Boolean(parsed.includeRemoteRegardlessOfDistance),
      relocationWillingness: Boolean(parsed.relocationWillingness),
    });
  }

  return (
    <section className="bg-white rounded-xl border border-slate-200 p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <button
            key={p.id}
            onClick={() => applyPreset(p)}
            className="rounded-full border border-brand/40 bg-brand/5 text-brand text-xs font-medium px-3 py-1.5 hover:bg-brand/10"
          >
            ⭐ {p.name}
          </button>
        ))}
        <button
          onClick={() => onChange(EMPTY_FILTERS)}
          className="text-xs text-slate-500 hover:text-brand underline"
        >
          Clear all filters
        </button>
      </div>

      <details open className="group">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">Location & distance</summary>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
          <TextField label="Location" value={filters.location} onChange={(v) => set("location", v)} />
          <SelectField
            label="Workplace type"
            value={filters.workplaceType}
            onChange={(v) => set("workplaceType", v)}
            options={["", "Remote", "Hybrid", "On Site"]}
          />
          <label className="flex items-center gap-2 text-xs text-slate-600 mt-5">
            <input
              type="checkbox"
              checked={filters.relocationWillingness}
              onChange={(e) => set("relocationWillingness", e.target.checked)}
              className="accent-[var(--brand)]"
            />
            Willing to relocate (ignore distance)
          </label>
          {!filters.relocationWillingness && (
            <>
              <TextField
                label="Max miles from Clifton, NJ"
                value={filters.maxDistanceMiles}
                onChange={(v) => set("maxDistanceMiles", v)}
                type="number"
              />
              <label className="flex items-center gap-2 text-xs text-slate-600 mt-5">
                <input
                  type="checkbox"
                  checked={filters.includeRemoteRegardlessOfDistance}
                  onChange={(e) => set("includeRemoteRegardlessOfDistance", e.target.checked)}
                  className="accent-[var(--brand)]"
                />
                Also include Remote roles
              </label>
            </>
          )}
        </div>
      </details>

      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">Timing</summary>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
          <SelectField
            label="Season"
            value={filters.season}
            onChange={(v) => set("season", v)}
            options={["", "Summer", "Fall", "Spring", "Winter"]}
          />
          <TextField label="Internship term" value={filters.internshipTerm} onChange={(v) => set("internshipTerm", v)} />
          <TextField label="Duration" value={filters.duration} onChange={(v) => set("duration", v)} />
          <TextField label="Posted from" value={filters.postingDateFrom} onChange={(v) => set("postingDateFrom", v)} type="date" />
          <TextField label="Posted to" value={filters.postingDateTo} onChange={(v) => set("postingDateTo", v)} type="date" />
          <TextField label="Verified from" value={filters.lastVerifiedFrom} onChange={(v) => set("lastVerifiedFrom", v)} type="date" />
          <TextField label="Verified to" value={filters.lastVerifiedTo} onChange={(v) => set("lastVerifiedTo", v)} type="date" />
        </div>
      </details>

      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">Engineering discipline</summary>
        <div className="mt-3 flex flex-wrap gap-2">
          {DISCIPLINE_TAGS.map((tag) => (
            <label
              key={tag}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs cursor-pointer ${
                filters.disciplines.includes(tag)
                  ? "border-brand bg-brand/10 text-brand"
                  : "border-slate-300 text-slate-600"
              }`}
            >
              <input
                type="checkbox"
                checked={filters.disciplines.includes(tag)}
                onChange={() => toggleDiscipline(tag)}
                className="hidden"
              />
              {DISCIPLINE_LABELS[tag]}
            </label>
          ))}
        </div>
      </details>

      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">Eligibility</summary>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
          <SelectField
            label="Sophomore eligible"
            value={filters.sophomoreEligible}
            onChange={(v) => set("sophomoreEligible", v)}
            options={["", "true", "false"]}
            labels={{ "": "Any", true: "Yes", false: "No" }}
          />
          <TextField label="Graduation year" value={filters.graduationYear} onChange={(v) => set("graduationYear", v)} type="number" />
          <SelectField
            label="Sponsorship"
            value={filters.sponsorship}
            onChange={(v) => set("sponsorship", v)}
            options={["", "Yes", "No", "NotSure", "Unknown"]}
          />
          <SelectField
            label="Citizenship / clearance"
            value={filters.citizenshipOrClearance}
            onChange={(v) => set("citizenshipOrClearance", v)}
            options={["", "true", "false"]}
            labels={{ "": "Any", true: "Required", false: "Not mentioned" }}
          />
        </div>
      </details>

      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">Compensation, score & status</summary>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
          <TextField label="Min compensation ($/hr)" value={filters.compMin} onChange={(v) => set("compMin", v)} type="number" />
          <TextField label="Min match score" value={filters.matchScoreMin} onChange={(v) => set("matchScoreMin", v)} type="number" />
          <SelectField
            label="Application status"
            value={filters.status}
            onChange={(v) => set("status", v)}
            options={["", ...TRACKER_STATUSES]}
          />
          <SelectField
            label="Availability"
            value={filters.availability}
            onChange={(v) => set("availability", v)}
            options={["", "official", "source_listed", "verification_pending", "closed", "security", "all"]}
            labels={{
              "": "Active feed (default)",
              official: "Officially verified",
              source_listed: "Source listed",
              verification_pending: "Verification pending",
              closed: "Closed confirmed",
              security: "Security blocked",
              all: "Everything",
            }}
          />
        </div>
        <p className="mt-3 text-xs text-slate-400">
          The Active feed shows every legitimate discovered job — officially verified, source listed,
          and verification pending — newest first. Closed/mismatch/security-blocked records are hidden
          from the default feed but reachable via the Availability filter above.
        </p>
      </details>
    </section>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="input-sm w-full" />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  labels,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  labels?: Record<string, string>;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="input-sm w-full">
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? (o === "" ? "Any" : o)}
          </option>
        ))}
      </select>
    </label>
  );
}
