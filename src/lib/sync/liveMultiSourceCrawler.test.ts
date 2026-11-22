import { describe, expect, it } from "vitest";
import {
  extractLinkedInExternalApplyUrl,
  parseHandshakePostings,
  parseIndeedSearchCards,
  parseLinkedInGuestCards,
} from "@/lib/sync/liveMultiSourceCrawler";

describe("liveMultiSourceCrawler parsers", () => {
  const capturedAt = new Date("2026-11-16T18:00:00.000Z");

  it("extracts engineering internships and exact/relative ages from LinkedIn guest cards", () => {
    const html = `
      <ul>
        <li>
          <div class="base-card">
            <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/software-engineer-intern-at-acme-4091234567?position=1">
              <span class="sr-only">Software Engineer Intern</span>
            </a>
            <h3 class="base-search-card__title">Software Engineer Intern - Summer 2027</h3>
            <h4 class="base-search-card__subtitle">Acme Robotics</h4>
            <span class="job-search-card__location">San Francisco, CA</span>
            <time datetime="2026-11-16T16:30:00Z">1 hour ago</time>
          </div>
        </li>
        <li>
          <div class="base-card">
            <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/marketing-coordinator-999999?position=2"></a>
            <h3 class="base-search-card__title">Marketing Coordinator</h3>
            <h4 class="base-search-card__subtitle">Acme Robotics</h4>
            <time datetime="2026-11-16T16:00:00Z">2 hours ago</time>
          </div>
        </li>
      </ul>
    `;

    const jobs = parseLinkedInGuestCards(html, capturedAt);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.boardSource).toBe("linkedin");
    expect(jobs[0]!.sourceJobId).toBe("linkedin:4091234567");
    expect(jobs[0]!.company).toBe("Acme Robotics");
    expect(jobs[0]!.location).toBe("San Francisco, CA");
    expect(jobs[0]!.postedAt?.getTime()).toBe(capturedAt.getTime() - 3_600_000);
  });

  it("extracts official ATS redirect links from LinkedIn job detail HTML", () => {
    const detailHtml = `
      <a href="https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fboards.greenhouse.io%2Fstripe%2Fjobs%2F123456%3Futm_source%3Dlinkedin"
         data-tracking-control-name="public_jobs_apply-link-offsite_sign-up">Apply</a>
    `;
    expect(extractLinkedInExternalApplyUrl(detailHtml)).toBe("https://boards.greenhouse.io/stripe/jobs/123456");
  });

  it("extracts 'Just posted' and hours-fresh internships from Indeed search HTML", () => {
    const html = `
      <div class="job_seen_beacon" data-jk="abc987654">
        <h2 class="jobTitle"><span>Machine Learning Engineer Intern</span></h2>
        <span data-testid="company-name">Vector Labs</span>
        <div data-testid="text-location">Remote</div>
        <span data-testid="myJobsStateDate">Just posted</span>
      </div>
      <div class="job_seen_beacon" data-jk="def111222">
        <h2 class="jobTitle"><span>Retail Cashier</span></h2>
        <span data-testid="company-name">Local Shop</span>
        <span data-testid="myJobsStateDate">Just posted</span>
      </div>
    `;

    const jobs = parseIndeedSearchCards(html, capturedAt);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.boardSource).toBe("indeed");
    expect(jobs[0]!.sourceJobId).toBe("indeed:abc987654");
    expect(jobs[0]!.workplaceType).toBe("Remote");
    expect(jobs[0]!.postedAt).not.toBeNull();
    expect(capturedAt.getTime() - jobs[0]!.postedAt!.getTime()).toBeLessThan(60 * 60 * 1000);
  });

  it("extracts JSON-LD engineering internships from Handshake HTML", () => {
    const html = `
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Embedded Firmware Engineering Intern",
          "datePosted": "2026-11-16T15:00:00Z",
          "hiringOrganization": { "name": "Anduril Systems" },
          "jobLocation": { "address": { "addressLocality": "Costa Mesa", "addressRegion": "CA" } },
          "url": "https://app.joinhandshake.com/stu/jobs/884422"
        }
      </script>
    `;

    const jobs = parseHandshakePostings(html, capturedAt);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.boardSource).toBe("handshake");
    expect(jobs[0]!.company).toBe("Anduril Systems");
    expect(jobs[0]!.location).toBe("Costa Mesa, CA");
    expect(jobs[0]!.postedAt?.toISOString()).toBe("2026-11-16T15:00:00.000Z");
  });
});
