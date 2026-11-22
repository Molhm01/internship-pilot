import { describe, expect, it } from "vitest";
import {
  extractLiteralFactsFromResumeText,
  extractProfileFieldsFromResumeText,
} from "./deterministicParser";

const SAMPLE_RESUME = `
Alex Rivera
alex.rivera@example.edu | (734) 555-0142 | github.com/arivera | linkedin.com/in/arivera

EDUCATION
University of Michigan, Ann Arbor, MI
B.S. in Computer Science, Expected May 2027 | GPA: 3.87/4.0
Coursework: Data Structures, Operating Systems, Distributed Systems, Machine Learning

TECHNICAL SKILLS
Languages: TypeScript, Python, Go, SQL
Frameworks & Tools: React, Next.js, PostgreSQL, Docker, PyTorch

EXPERIENCE
Software Engineering Intern, Acme Cloud Systems (May 2025 - Aug 2025)
- Built Go microservices and PostgreSQL query caching reducing p95 latency by 35%.

PROJECTS
Telemetry Engine: Real-time Rust and React observability pipeline handling 10k events/s.
`;

describe("deterministic literal resume parser", () => {
  it("extracts education, gpa, graduation, coursework, skills, experience, and projects literally", () => {
    const facts = extractLiteralFactsFromResumeText(SAMPLE_RESUME);
    const types = new Set(facts.map((f) => f.type));

    expect(facts.length).toBeGreaterThanOrEqual(10);
    expect(types.has("education")).toBe(true);
    expect(types.has("gpa")).toBe(true);
    expect(types.has("graduationDate")).toBe(true);
    expect(types.has("coursework")).toBe(true);
    expect(types.has("skill")).toBe(true);
    expect(types.has("experience")).toBe(true);
    expect(types.has("project")).toBe(true);

    expect(facts.some((f) => f.type === "gpa" && f.content.includes("3.87"))).toBe(true);
    expect(facts.some((f) => f.type === "skill" && f.content === "TypeScript")).toBe(true);
    expect(facts.some((f) => f.type === "experience" && f.content.includes("Acme Cloud Systems"))).toBe(true);
  });

  it("extracts contact, school, major, gpa, and graduationDate profile fields", () => {
    const profile = extractProfileFieldsFromResumeText(SAMPLE_RESUME);
    expect(profile.fullName).toBe("Alex Rivera");
    expect(profile.email).toBe("alex.rivera@example.edu");
    expect(profile.phone).toBe("(734) 555-0142");
    expect(profile.github).toBe("https://github.com/arivera");
    expect(profile.linkedin).toBe("https://linkedin.com/in/arivera");
    expect(profile.school).toBe("University of Michigan");
    expect(profile.major).toBe("Computer Science");
    expect(profile.gpa).toBe("3.87");
    expect(profile.graduationDate).toBe("2027-05");
  });

  it("extracts bare 10-digit phone, linkedin, and portfolio website URLs cleanly", () => {
    const profile = extractProfileFieldsFromResumeText(`
Molhm Alasri
NYC Metro | molhmalasri7@gmail.com | 9292643117 | linkedin.com/in/molhm-alasri/ | Portfolio: molhm-alasri-portfolio.vercel.app
`);
    expect(profile.fullName).toBe("Molhm Alasri");
    expect(profile.email).toBe("molhmalasri7@gmail.com");
    expect(profile.phone).toBe("9292643117");
    expect(profile.linkedin).toBe("https://linkedin.com/in/molhm-alasri/");
    expect(profile.website).toBe("https://molhm-alasri-portfolio.vercel.app");
  });

  it("extracts NJIT Electrical Engineering (May 2029) before transferred Stevens entry", () => {
    const profile = extractProfileFieldsFromResumeText(`
Molhm Alasri
molhmalasri7@gmail.com | 9292643117

EDUCATION
New Jersey Institute of Technology \tNewark, NJ
B.S. Electrical Engineering \tExpected Graduation: May 2029
Relevant Sophomore Coursework: Digital Design, Circuits & Systems I, Differential Equations
Stevens Institute of Technology \tHoboken, NJ
B.E. Computer Engineering. Dean's List | Presidential Achievement Scholarship. GPA: 3.76. \tSep 2025 - May 2026
`);
    expect(profile.school).toBe("New Jersey Institute of Technology");
    expect(profile.major).toBe("Electrical Engineering");
    expect(profile.graduationDate).toBe("2029-05");
    expect(profile.gpa).toBe("3.76");
  });
});
