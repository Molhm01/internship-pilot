import { describe, expect, it } from "vitest";
import { parseInternListPayload } from "./internListAdapter";

function payload(job: Record<string, unknown>) {
  return {
    props: {
      pageProps: {
        initialJobs: [{
          id: "job-1",
          title: "Engineering Intern",
          company: "Acme",
          qualifications: "Python",
          ...job,
        }],
      },
    },
  };
}

describe("Intern List upstream URL metadata", () => {
  it("keeps Jobright as the source and stores an upstream original ATS URL separately", () => {
    const [job] = parseInternListPayload(payload({
      applyUrl: "https://jobright.ai/jobs/info/job-1",
      originalUrl: "https://jobs.lever.co/acme/job-1",
    }));
    expect(job.sourceListingUrl).toBe("https://jobright.ai/jobs/info/job-1");
    expect(job.applyUrl).toBe("https://jobright.ai/jobs/info/job-1");
    expect(job.officialApplicationUrl).toBe("https://jobs.lever.co/acme/job-1");
    expect(job.originalJobPostUrl).toBe("https://jobs.lever.co/acme/job-1");
  });

  it("does not promote a Jobright-only applyUrl to officialApplicationUrl", () => {
    const [job] = parseInternListPayload(payload({
      applyUrl: "https://jobright.ai/jobs/info/job-1",
    }));
    expect(job.sourceListingUrl).toBe("https://jobright.ai/jobs/info/job-1");
    expect(job.officialApplicationUrl).toBeNull();
    expect(job.originalJobPostUrl).toBeNull();
  });
});
