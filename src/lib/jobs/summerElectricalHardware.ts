import { computeActiveFeed, type ActiveFeedInput } from "@/lib/jobs/sourcePolicy";
import { classifyDisciplines, type DisciplineTag } from "@/lib/sync/classify";
import { classifyInternship, isQualifying } from "@/lib/sync/internshipClassifier";

export const SUMMER_ELECTRICAL_HARDWARE = {
  id: "summer-electrical-hardware",
  name: "Summer Electrical & Hardware",
} as const;

const TARGET_DISCIPLINES = new Set<DisciplineTag>([
  "electrical",
  "computerEngineering",
  "embedded",
  "hardware",
  "electronics",
  "firmware",
  "fpga",
  "digitalVerification",
  "powerEnergy",
  "rf",
]);

// Titles such as "Hardware Intern" omit the "engineer" or "engineering"
// qualifiers used by some of the general-purpose discipline classifiers.
const TARGET_TITLE = /\b(?:electrical|electronics|hardware|embedded|firmware|fpga|rtl|asic|rf|pcb)\b/i;
const UNRELATED_TITLE = /\b(?:software|mechanical|civil|chemical|operations|manufacturing|sales|finance|marketing)\b/i;
const SUMMER = /\bsummer\b/i;
const OTHER_SEASON = /\b(?:spring|fall|autumn|winter)\b/i;

type Posting = ActiveFeedInput & {
  title: string;
  description: string;
  season: string | null;
  internshipTerm: string | null;
  reasonCode: string | null;
};

export function matchesSummerElectricalHardware(job: Posting): boolean {
  const term = [job.season, job.internshipTerm, job.title].join(" ");
  if (!SUMMER.test(term) || OTHER_SEASON.test(term)) return false;
  if (job.reasonCode === "CLOSED_EXPIRED" || !computeActiveFeed(job)) return false;
  if (!isQualifying(classifyInternship(job).classification)) return false;

  const titleDisciplines = classifyDisciplines(job.title, "");
  if (TARGET_TITLE.test(job.title) || titleDisciplines.some((tag) => TARGET_DISCIPLINES.has(tag))) return true;
  // A clearly unrelated title takes precedence over a mention in the body,
  // such as a list of degrees accepted for a software internship.
  if (titleDisciplines.length > 0 || UNRELATED_TITLE.test(job.title)) return false;
  return classifyDisciplines("", job.description).some((tag) => TARGET_DISCIPLINES.has(tag));
}
