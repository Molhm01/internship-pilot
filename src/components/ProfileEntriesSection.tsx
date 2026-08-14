"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Work history and projects, as structured rows.
 *
 * These are not more columns on the profile because an application form asks
 * for an employer, a title and two dates as four separate answers, and one line
 * of résumé prose cannot be split into them without guessing which part is
 * which. Responsibilities and bullets are stored as approved lists so the agent
 * quotes what the user wrote rather than composing something new.
 */

type Entry = Record<string, unknown>;

type Kind = "experience" | "project";

const FIELDS: Record<Kind, ReadonlyArray<{ name: string; label: string; list?: boolean }>> = {
  experience: [
    { name: "employer", label: "Employer" },
    { name: "title", label: "Position" },
    { name: "location", label: "Location" },
    { name: "startDate", label: "Start date" },
    { name: "endDate", label: "End date" },
    { name: "responsibilities", label: "Responsibilities", list: true },
    { name: "approvedBullets", label: "Approved résumé bullets", list: true },
  ],
  project: [
    { name: "name", label: "Project" },
    { name: "description", label: "Approved description" },
    { name: "technologies", label: "Technologies", list: true },
    { name: "approvedSkills", label: "Skills this supports", list: true },
  ],
};

const REQUIRED: Record<Kind, string> = { experience: "employer", project: "name" };

function text(entry: Entry, name: string): string {
  const value = entry[name];
  return typeof value === "string" ? value : "";
}

function list(entry: Entry, name: string): string {
  const value = entry[name];
  if (typeof value !== "string" || !value) return "";
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e === "string").join("\n") : "";
  } catch {
    return "";
  }
}

function EntryEditor({
  kind,
  entry,
  onSaved,
}: {
  kind: Kind;
  entry: Entry;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Entry>(entry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = typeof entry.id === "string" ? entry.id : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      for (const field of FIELDS[kind]) {
        body[field.name] = field.list
          ? list(draft, field.name)
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
          : text(draft, field.name);
      }
      if (kind === "experience") body.currentlyEmployed = draft.currentlyEmployed === true;

      const response = await fetch(
        id ? `/api/profile/${kind}/${id}` : `/api/profile/${kind}`,
        {
          method: id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "That entry could not be saved.");
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!id) return;
    setBusy(true);
    await fetch(`/api/profile/${kind}/${id}`, { method: "DELETE" });
    setBusy(false);
    onSaved();
  }

  const required = text(draft, REQUIRED[kind]).trim();

  return (
    <form onSubmit={submit} className="rounded-lg border border-hairline p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {FIELDS[kind].map((field) =>
          field.list ? (
            <label key={field.name} className="col-span-2 block text-sm">
              <span className="text-secondary">{field.label}</span>
              <textarea
                rows={3}
                value={list(draft, field.name)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    [field.name]: JSON.stringify(
                      event.target.value
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean),
                    ),
                  })
                }
                className="input mt-1 w-full"
              />
              <span className="mt-1 block text-xs text-tertiary">One per line.</span>
            </label>
          ) : (
            <label key={field.name} className="block text-sm">
              <span className="text-secondary">{field.label}</span>
              <input
                value={text(draft, field.name)}
                onChange={(event) => setDraft({ ...draft, [field.name]: event.target.value })}
                className="input mt-1 w-full"
              />
            </label>
          ),
        )}
        {kind === "experience" ? (
          <label className="flex items-center gap-2 text-sm text-secondary">
            <input
              type="checkbox"
              checked={draft.currentlyEmployed === true}
              onChange={(event) => setDraft({ ...draft, currentlyEmployed: event.target.checked })}
            />
            Currently employed here
          </label>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !required}
          className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {id ? "Save" : "Add"}
        </button>
        {id ? (
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="text-sm text-critical hover:underline"
          >
            Remove
          </button>
        ) : null}
        {!required ? (
          <span className="text-xs text-tertiary">
            {kind === "experience" ? "An employer" : "A project name"} is required.
          </span>
        ) : null}
        {error ? <span className="text-sm text-critical">{error}</span> : null}
      </div>
    </form>
  );
}

export default function ProfileEntriesSection() {
  const [experiences, setExperiences] = useState<Entry[]>([]);
  const [projects, setProjects] = useState<Entry[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Bumped after every save so the blank "add" editors reset rather than
  // keeping the text of the entry that was just created.
  const [generation, setGeneration] = useState(0);

  const load = useCallback(async () => {
    const response = await fetch("/api/profile/entries");
    if (!response.ok) {
      setLoaded(true);
      return;
    }
    const data = (await response.json()) as { experiences: Entry[]; projects: Entry[] };
    setExperiences(data.experiences ?? []);
    setProjects(data.projects ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => {
    setGeneration((value) => value + 1);
    void load();
  };

  if (!loaded) return <p className="text-sm text-tertiary">Loading…</p>;

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-hairline bg-surface p-6 space-y-4">
        <h2 className="font-medium text-primary">Experience</h2>
        {experiences.map((entry) => (
          <EntryEditor
            key={String(entry.id)}
            kind="experience"
            entry={entry}
            onSaved={refresh}
          />
        ))}
        <EntryEditor key={`new-experience-${generation}`} kind="experience" entry={{}} onSaved={refresh} />
      </section>

      <section className="rounded-lg border border-hairline bg-surface p-6 space-y-4">
        <h2 className="font-medium text-primary">Projects</h2>
        {projects.map((entry) => (
          <EntryEditor key={String(entry.id)} kind="project" entry={entry} onSaved={refresh} />
        ))}
        <EntryEditor key={`new-project-${generation}`} kind="project" entry={{}} onSaved={refresh} />
      </section>
    </div>
  );
}
