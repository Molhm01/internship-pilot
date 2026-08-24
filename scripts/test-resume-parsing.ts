const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

const SAMPLE_RESUME = `
Jamie Rivera
B.S. in Computer Science, State University, Expected Graduation: May 2027
GPA: 3.7

Relevant Coursework: Data Structures and Algorithms, Database Systems, Operating Systems

Skills: Python, JavaScript, SQL, Git, React

Projects:
- Course Scheduler (2026): Built a full-stack web app with React and Node.js that helps students
  plan class schedules. Used PostgreSQL for storage.

Experience:
- IT Help Desk Assistant, University IT Services (Sept 2025 - present): Troubleshoot hardware and
  software issues for students and staff, part-time, 10 hrs/week.

Activities:
- Member, Computer Science Club (2025 - present)
`;

async function main() {
  console.log("POST /api/resume/analyze with a sample resume...");
  const res = await fetch(`${BASE_URL}/api/resume/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resumeText: SAMPLE_RESUME }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${JSON.stringify(data)}`);
  }

  console.log(`Extracted ${data.facts.length} facts:`);
  for (const f of data.facts) {
    console.log(`  [${f.type}] ${f.content}${f.detail ? " — " + f.detail : ""}`);
  }

  if (data.facts.length === 0) {
    throw new Error("Expected at least some facts to be extracted, got zero.");
  }

  const hasSkill = data.facts.some((f: { type: string }) => f.type === "skill");
  if (!hasSkill) {
    throw new Error("Expected at least one 'skill' fact to be extracted.");
  }

  console.log("\nResume parsing test PASSED.");
}

main().catch((err) => {
  console.error("\nResume parsing test FAILED:", err.message);
  process.exitCode = 1;
});

export {};
