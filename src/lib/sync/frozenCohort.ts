import type { RawInternListJob } from "@/lib/sync/internListAdapter";
import type { SourceDateConfidence } from "@/lib/sync/sourceDate";

/**
 * A radar signal, frozen exactly as the source published it.
 *
 * The live radar rotates its population continuously, so two benchmark runs an
 * hour apart measure two different denominators. This project already lost a
 * day to that: 56.7% and 26.7% looked like a catastrophic regression and were
 * simply different signals. Freezing the input makes "did the resolver improve"
 * answerable.
 *
 * Only the SIGNAL is frozen. Resolution is not: every benchmark run still
 * crawls the employer's real board, because that is the thing under test.
 */
export type FrozenSignal = {
  source: "jobright";
  sourceJobId: string;
  capturedAt: string;
  sourcePostedAt: string | null;
  sourcePostedText: string | null;
  sourceDateConfidence: SourceDateConfidence;
  sourceRowIndex: number;
  company: string;
  title: string;
  location: string | null;
  workModel: string | null;
  qualifications: string;
  sourceUrl: string | null;
  classification: "valid" | "irrelevant" | "stale";
};

export type FrozenCohort = {
  name: string;
  capturedAt: string;
  radarSignalsFetched: number;
  freshUnder24h: number;
  freshUnder72h: number;
  signals: FrozenSignal[];
};

/** Default location of the checked-in cohort fixture. */
export const FROZEN_COHORT_PATH = "benchmarks/fresh-discovery-frozen.json";

/**
 * Rehydrate a frozen signal into the shape the resolver consumes.
 *
 * Deliberately lossless about the fields resolution reads and empty about the
 * ones it must not depend on: a frozen signal carries no aggregator apply URL,
 * so the benchmark can never "resolve" a job by reusing a stored answer.
 */
export function toRadarSignal(signal: FrozenSignal): RawInternListJob {
  return {
    sourceJobId: signal.sourceJobId,
    title: signal.title,
    company: signal.company,
    location: signal.location,
    workModel: signal.workModel,
    postedAt: signal.sourcePostedAt ? new Date(signal.sourcePostedAt) : null,
    sourcePostedAt: signal.sourcePostedAt ? new Date(signal.sourcePostedAt) : null,
    sourcePostedText: signal.sourcePostedText,
    sourceDateConfidence: signal.sourceDateConfidence,
    sourceRowIndex: signal.sourceRowIndex,
    hireTime: null,
    salary: null,
    qualifications: signal.qualifications,
    applyUrl: signal.sourceUrl,
    h1bSponsored: null,
  };
}

export function validSignals(cohort: FrozenCohort): FrozenSignal[] {
  return cohort.signals.filter((signal) => signal.classification === "valid");
}
