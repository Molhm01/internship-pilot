import {
  ensureCurrentApplicationDocuments,
  fetchDocumentPdf,
  type StoredGeneratedDocument,
} from "@/lib/documents/client";
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
  /** User preference; the normal Apply flow prepares a cover letter by default. */
  coverLetterDesired?: boolean;
  neverClaimFacts?: string[];
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
  openWindow?: (url: string, target: string, features: string) => Window | null;
  ensureDocuments?: typeof ensureCurrentApplicationDocuments;
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
  fingerprint: string,
  fetchPdf: typeof fetchDocumentPdf,
): Promise<BundleDocumentInput> {
  if (stored.documentFingerprint !== fingerprint) {
    throw new ExtensionBridgeError("A prepared document did not match this job's current freshness fingerprint.");
  }
  const blob = await fetchPdf(stored.id);
  return {
    documentId: stored.id,
    websiteJobId: input.websiteJobId,
    kind,
    filename: filenameFor(kind, input.company, input.jobTitle),
    mimeType: "application/pdf",
    bytes: await blob.arrayBuffer(),
    generatedAt: stored.createdAt,
    documentFingerprint: fingerprint,
    qaStatus: "pass",
    identityVerified: true,
  };
}

export type ApplyWithAgentResult = BundleTransferResult & {
  openedUrl: string;
  /** Profile gaps the user should know about; the handoff still succeeded. */
  missingProfileFields: string[];
  documentsReused: boolean;
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
  const ensureDocuments = dependencies.ensureDocuments ?? ensureCurrentApplicationDocuments;

  // Reserve the employer tab while the click still has browser user activation.
  // Document preparation can take long enough that a later window.open would be
  // popup-blocked. Nothing employer-owned is loaded until the bundle is stored.
  const applicationWindow = openWindow("about:blank", "_blank", "popup");
  if (!applicationWindow) {
    throw new ExtensionBridgeError("The browser blocked the application tab. Allow pop-ups for Internship Pilot and try again.");
  }
  try {
    applicationWindow.opener = null;

  const eligibility = applyEligibility({
    officialApplicationUrl: input.officialApplicationUrl,
    documents: input.documents,
    coverLetterRequired: input.coverLetterRequired,
    bridgeAvailable: await probeBridge(),
  });
  if (!eligibility.ready) throw new ExtensionBridgeError(eligibility.reason);

  const readiness = await ensureDocuments(
    input.websiteJobId,
    input.coverLetterRequired || input.coverLetterDesired !== false,
  );
  const resume = newestValidDocument(readiness.documents, "resume");
  const coverLetter = newestValidDocument(readiness.documents, "coverLetter");
  if (!resume) throw new ExtensionBridgeError("Automatic document preparation did not produce a QA-passed résumé.");
  if (input.coverLetterRequired && !coverLetter) {
    throw new ExtensionBridgeError("Automatic document preparation did not produce the required cover letter.");
  }

  const documents: BundleDocumentInput[] = [
    await toBundleDocument("resume", resume, input, readiness.fingerprint, fetchPdf),
    ...(coverLetter ? [await toBundleDocument("cover_letter", coverLetter, input, readiness.fingerprint, fetchPdf)] : []),
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
    documentFingerprint: readiness.fingerprint,
    documentsReused: readiness.reused,
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
    answerContext: {
      neverClaimFacts: input.neverClaimFacts ?? [],
      employerSpecificApprovedAnswers: profilePart.companyRelationship ? [profilePart.companyRelationship] : [],
    },
  };

  // Navigation happens only after this resolves. If the extension never
  // acknowledges, the user stays here and is told why.
  const transferred = await sendBundle(bundle);

  applicationWindow.location.replace(input.officialApplicationUrl);
  return {
    ...transferred,
    openedUrl: input.officialApplicationUrl,
    missingProfileFields: profilePart.missingFields ?? [],
    documentsReused: readiness.reused,
  };
  } catch (error) {
    applicationWindow.close();
    throw error;
  }
}
