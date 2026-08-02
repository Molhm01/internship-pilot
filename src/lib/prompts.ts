import type { FactType } from "@/lib/statuses";

export function buildResumeAnalysisPrompt(resumeText: string): string {
  return `You are a strict, literal resume-fact extractor. You must ONLY report facts that are explicitly written in the resume text below. Never guess, infer, embellish, or add anything that is not directly stated. If something is ambiguous or missing, leave it out entirely rather than guessing.

Extract facts into these categories only: education, gpa, graduationDate, coursework, skill, project, experience, activity.

Rules:
- "skill" facts must be individual skills, tools, or languages literally named in the text (e.g. "Python", "SQL", "Figma"). Do not group multiple skills into one fact.
- "experience" and "project" facts should each be one role or one project, with a short factual description copied or tightly paraphrased from the text (include organization/dates if present).
- "coursework" facts are individual course names.
- Do not output duplicate facts.
- Do not output a fact for a category if the resume does not mention it.
- "content" must be short and factual (max ~15 words). Put any longer supporting context in "detail".

Return ONLY valid JSON with this exact shape, no commentary, no markdown fences:
{
  "facts": [
    { "type": "skill", "content": "Python", "detail": "Used in 2 listed projects" }
  ]
}

RESUME TEXT:
"""
${resumeText}
"""`;
}

export type FactForPrompt = {
  id: string;
  type: FactType | string;
  content: string;
  detail?: string | null;
};

export function buildMatchPrompt(facts: FactForPrompt[], job: {
  title: string;
  company: string;
  description: string;
  internshipTerm?: string | null;
  duration?: string | null;
  location?: string | null;
}): string {
  const factList = facts
    .map((f) => `- [${f.id}] (${f.type}) ${f.content}${f.detail ? ` — ${f.detail}` : ""}`)
    .join("\n");

  return `You are an honest, evidence-only internship-application assistant. You must NEVER claim the candidate has a skill or qualification unless it is directly supported by one of the APPROVED RESUME FACTS listed below. These facts are the ONLY things you know to be true about the candidate. Do not use outside assumptions about what a typical candidate might know.

APPROVED RESUME FACTS (each has an id in brackets):
${factList || "(no approved facts yet)"}

JOB POSTING:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location ?? "unknown"}
Internship term: ${job.internshipTerm ?? "unknown"}
Duration: ${job.duration ?? "unknown"}
Description:
"""
${job.description}
"""

Do the following:
1. Determine ELIGIBILITY: "Pass" if the candidate clearly meets all explicit hard requirements you can verify from the approved facts (e.g. GPA minimum, class year, degree field, work authorization if mentioned), "Fail" if an explicit hard requirement is clearly NOT met, or "Unknown" if the posting states a hard requirement that the approved facts do not give enough information to verify. Give a one to two sentence eligibilityReason.
   - A broadly related major is not an exact degree match. For example, Computer Engineering evidence may support "a related engineering degree" when the posting allows related fields, but it must never be called a Civil Engineering degree.
2. Calculate a matchScore as an INTEGER from 0 to 100 reflecting how well the approved facts align with the job's stated requirements and responsibilities.
3. Write a short explanation (3-5 sentences) of exactly why that score was given, referencing specific approved facts by their content.
4. Split relevant skills/requirements mentioned in the job posting into four lists:
   - skillsSupported: skills the job wants that are clearly, directly evidenced by an approved fact. Each item MUST include the factIds (array of ids) that prove it.
   - skillsNeedConfirmation: skills the job wants that are plausibly related to an approved fact but not a clean direct match (e.g. job wants "cloud deployment", candidate has "AWS S3 in a class project") — include the related factIds.
   - skillsToLearn: skills the job wants that the candidate has NO evidence of, but are reasonable and quick for a student to learn before or during the internship. No factIds (leave empty array).
   - skillsNeverAdd: skills or qualifications the job wants that the candidate has NO evidence of and should NOT claim to have on an application (e.g. things requiring real professional experience, certifications, or years of use the candidate has never had). No factIds (leave empty array).
   - If you considered describing an unsupported requirement as something the candidate has, put that requirement in skillsNeverAdd instead. Never convert a job requirement into a candidate fact.
   A skill must appear in exactly one of these four lists, never more than one.
5. Give a one-word recommendation: "Apply" (eligibility is Pass or Unknown and matchScore is reasonably high), "Skip" (eligibility is Fail, or match is very weak), or "Consider" (borderline). Never recommend "Apply" if eligibility is "Fail".
6. Write a tailoringPreview: 2-4 short bullet-point suggestions for how the candidate could phrase their resume for THIS job, using ONLY approved facts (paraphrasing/reordering/emphasizing real facts — never inventing new experience). Each bullet must be traceable to an approved fact.

Return ONLY valid JSON, no commentary, no markdown fences, in exactly this shape:
{
  "eligibility": "Pass" | "Fail" | "Unknown",
  "eligibilityReason": "string",
  "matchScore": 0,
  "explanation": "string",
  "recommendation": "Apply" | "Skip" | "Consider",
  "skillsSupported": [ { "skill": "string", "reason": "string", "factIds": ["id1"] } ],
  "skillsNeedConfirmation": [ { "skill": "string", "reason": "string", "factIds": ["id1"] } ],
  "skillsToLearn": [ { "skill": "string", "reason": "string" } ],
  "skillsNeverAdd": [ { "skill": "string", "reason": "string" } ],
  "tailoringPreview": [ "string" ]
}

Every array shown above is REQUIRED, even when it is empty.`;
}

// Compact equivalent used by the high-throughput queue. It preserves the
// same decision and grounding rules while avoiding repeated prose that makes
// the model spend time re-reading the output contract for every job.
export function buildCompactMatchPrompt(facts: FactForPrompt[], job: {
  title: string;
  company: string;
  description: string;
  internshipTerm?: string | null;
  duration?: string | null;
  location?: string | null;
}): string {
  const factList = facts
    .map((fact) => `- [${fact.id}] (${fact.type}) ${fact.content}${fact.detail ? ` — ${fact.detail}` : ""}`)
    .join("\n");
  return `Evaluate this internship using ONLY the approved facts. Never invent or infer degrees, majors, coursework, projects, tools, employment, certifications, authorization, clearance, or years of experience. A related engineering major is not an exact degree match. Unsupported job requirements are gaps, never candidate facts.

APPROVED FACTS (cite ids for supported or confirmation items):
${factList || "(none)"}

JOB
Title: ${job.title}
Company: ${job.company}
Location: ${job.location ?? "unknown"}
Term: ${job.internshipTerm ?? "unknown"}
Duration: ${job.duration ?? "unknown"}
${job.description}

Rules:
- eligibility: Pass only when verified hard requirements are met; Fail when one is clearly unmet; otherwise Unknown.
- matchScore: integer 0-100 based on stated responsibilities and requirements.
- explanation: 2-3 concise grounded sentences.
- skillsSupported: directly evidenced and includes proving factIds.
- skillsNeedConfirmation: related but not exact evidence and includes related factIds.
- skillsToLearn: unsupported learnable gaps with factIds:[].
- skillsNeverAdd: unsupported qualifications the candidate must not claim with factIds:[].
- Each requirement appears in one list only. Never turn job wording into a candidate fact.
- recommendation: Apply, Skip, or Consider; never Apply when eligibility is Fail.
- tailoringPreview: 2-3 short supported paraphrase or reordering suggestions.

Return compact JSON only; every array is required:
{"eligibility":"Pass|Fail|Unknown","eligibilityReason":"grounded reason","matchScore":0,"explanation":"grounded explanation","recommendation":"Apply|Skip|Consider","skillsSupported":[],"skillsNeedConfirmation":[],"skillsToLearn":[],"skillsNeverAdd":[],"tailoringPreview":[]}`;
}
