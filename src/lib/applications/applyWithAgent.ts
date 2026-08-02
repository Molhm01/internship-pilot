import { fetchDocumentPdf, type StoredGeneratedDocument } from "@/lib/documents/client";
import {
  isExtensionBridgeAvailable,
  sendApplicationBundle,
  ExtensionBridgeError,
  type ApplicationBundleInput,
  type BundleDocumentInput,
  type BundleTransferResult,
} from "./extensionBridge";

/**
 * "Apply with Application Agent", end to end.
 *
 * Order matters and is the whole point: documents are fetched with the site's
 * own authenticated session, handed to the extension, confirmed stored, and
 * only then is the employer page opened. A failure at any step leaves the user
 * on Internship Pilot with an explanation rather than on an employer form with
 * no documents loaded.
 */

export type ApplyEligibilityInput = {
  officialApplicationUrl: string | null;
  documents: readonly StoredGeneratedDocument[];
  /** Some postings genuinely do not ask for a cover letter. */
  coverLetterRequired: boolean;
  bridgeAvailable: boolean;
};

export type ApplyEligibility =
  | { ready: true }
  | { ready: false; reason: string };

/** The newest QA-passed, identity-verified document of a type, or null. */
export function newestValidDocument(
  documents: readonly StoredGeneratedDocument[],
  type: "resume" | "coverLetter",
): StoredGeneratedDocument | null {
  return (
    documents
      .filter(
        (document) =>
          document.type === type && document.qaStatus === "pass" && document.identityVerified,
      )
      .sort((left, right) => right.version - left.version)[0] ?? null
  );
}

/**
 * Whether the button may be enabled. Every "no" names the missing thing, so the
 * UI never shows a disabled control without saying what would enable it.
 */
export function applyEligibility(input: ApplyEligibilityInput): ApplyEligibility {
  if (!input.officialApplicationUrl) {
    return { ready: false, reason: "The official employer application page has not been resolved yet." };
  }
  if (!newestValidDocument(input.documents, "resume")) {
    return { ready: false, reason: "Generate a tailored résumé for this job first." };
  }
  if (input.coverLetterRequired && !newestValidDocument(input.documents, "coverLetter")) {
    return { ready: false, reason: "Generate a tailored cover letter for this job first." };
  }
  if (!input.bridgeAvailable) {
    return {
      ready: false,
      reason: "The Application Agent extension is not responding on this page. Install or reload it, then refresh.",
    };
  }
  return { ready: true };
}

export type ApplyWithAgentInput = {
  websiteJobId: string;
  company: string;
  jobTitle: string;
  jobDescription: string;
  officialApplicationUrl: string;
  documents: readonly StoredGeneratedDocument[];
  coverLetterRequired: boolean;
};

export type ProfileBundlePart = {
  bundleVersion?: number;
  profile?: unknown;
  approvedAnswers?: unknown[];
  accountPreferences?: unknown;
  /** Absent when the user has told us nothing about this employer. */
  companyRelationship?: unknown;
  missingFields?: string[];
};

/**
 * Reads the canonical profile the moment before the handoff, so the extension
 * receives what the user has saved now rather than a copy that drifted.
 *
 * The company is passed so the employer-specific facts — previous employment,
 * a referral, a prior application — come back scoped to the employer actually
 * being applied to.
 */
export async function fetchProfileBundlePart(
  company?: string,
  fetcher: typeof fetch = fetch,
): Promise<ProfileBundlePart> {
  const query = company ? `?company=${encodeURIComponent(company)}` : "";
  const response = await fetcher(`/api/application-bundle${query}`);
  if (!response.ok) {
    throw new ExtensionBridgeError(
      "Your application profile could not be read. Open the Profile page, fill it in, and try again.",
    );
  }
  return (await response.json()) as ProfileBundlePart;
}

export type ApplyWithAgentDependencies = {
  fetchPdf?: typeof fetchDocumentPdf;
  fetchProfile?: typeof fetchProfileBundlePart;
  probeBridge?: typeof isExtensionBridgeAvailable;
  sendBundle?: typeof sendApplicationBundle;
  openWindow?: (url: string, target: string, features: string) => unknown;
};

function filenameFor(kind: "resume" | "cover_letter", company: string, jobTitle: string): string {
  const slug = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 40) || "application";
  const label = kind === "resume" ? "Resume" : "Cover-Letter";
  return `${label}-${slug(company)}-${slug(jobTitle)}.pdf`;
}

async function toBundleDocument(
  kind: "resume" | "cover_letter",
  stored: StoredGeneratedDocument,
  input: ApplyWithAgentInput,
  fetchPdf: typeof fetchDocumentPdf,
): Promise<BundleDocumentInput> {
  const blob = await fetchPdf(stored.id);
  return {
    kind,
    filename: filenameFor(kind, input.company, input.jobTitle),
    mimeType: "application/pdf",
    bytes: await blob.arrayBuffer(),
    generatedAt: stored.createdAt,
  };
}

export type ApplyWithAgentResult = BundleTransferResult & {
  openedUrl: string;
  /** Profile gaps the user should know about; the handoff still succeeded. */
  missingProfileFields: string[];
};

export async function applyWithApplicationAgent(
  input: ApplyWithAgentInput,
  dependencies: ApplyWithAgentDependencies = {},
): Promise<ApplyWithAgentResult> {
  const fetchPdf = dependencies.fetchPdf ?? fetchDocumentPdf;
  const fetchProfile = dependencies.fetchProfile ?? fetchProfileBundlePart;
  const probeBridge = dependencies.probeBridge ?? isExtensionBridgeAvailable;
  const sendBundle = dependencies.sendBundle ?? sendApplicationBundle;
  const openWindow = dependencies.openWindow ?? ((url, target, features) => window.open(url, target, features));

  const eligibility = applyEligibility({
    officialApplicationUrl: input.officialApplicationUrl,
    documents: input.documents,
    coverLetterRequired: input.coverLetterRequired,
    bridgeAvailable: await probeBridge(),
  });
  if (!eligibility.ready) throw new ExtensionBridgeError(eligibility.reason);

  const resume = newestValidDocument(input.documents, "resume");
  const coverLetter = newestValidDocument(input.documents, "coverLetter");
  if (!resume) throw new ExtensionBridgeError("Generate a tailored résumé for this job first.");

  const documents: BundleDocumentInput[] = [
    await toBundleDocument("resume", resume, input, fetchPdf),
    ...(coverLetter ? [await toBundleDocument("cover_letter", coverLetter, input, fetchPdf)] : []),
  ];

  // The profile travels with the documents: one handoff, one consistent view
  // of who is applying and with what.
  const profilePart = await fetchProfile(input.company);

  const bundle: ApplicationBundleInput = {
    websiteJobId: input.websiteJobId,
    company: input.company,
    jobTitle: input.jobTitle,
    jobDescription: input.jobDescription,
    officialApplicationUrl: input.officialApplicationUrl,
    documents,
    ...(typeof profilePart.bundleVersion === "number"
      ? { bundleVersion: profilePart.bundleVersion }
      : {}),
    ...(profilePart.profile ? { profile: profilePart.profile } : {}),
    approvedAnswers: profilePart.approvedAnswers ?? [],
    ...(profilePart.accountPreferences ? { accountPreferences: profilePart.accountPreferences } : {}),
    ...(profilePart.companyRelationship
      ? { companyRelationship: profilePart.companyRelationship }
      : {}),
  };

  // Navigation happens only after this resolves. If the extension never
  // acknowledges, the user stays here and is told why.
  const transferred = await sendBundle(bundle);

  openWindow(input.officialApplicationUrl, "_blank", "noopener,noreferrer");
  return {
    ...transferred,
    openedUrl: input.officialApplicationUrl,
    missingProfileFields: profilePart.missingFields ?? [],
  };
}
