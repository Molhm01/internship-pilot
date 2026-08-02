const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

async function main() {
  console.log("Checking approved resume facts exist (run `npm run seed` first if this fails)...");
  const factsRes = await fetch(`${BASE_URL}/api/resume/facts?status=approved`);
  const factsData = await factsRes.json();
  if (!factsData.facts || factsData.facts.length === 0) {
    throw new Error("No approved resume facts found. Run `npm run seed` first.");
  }
  console.log(`Found ${factsData.facts.length} approved facts.`);

  console.log("Fetching jobs list...");
  const jobsRes = await fetch(`${BASE_URL}/api/jobs`);
  const jobsData = await jobsRes.json();
  if (!jobsData.jobs || jobsData.jobs.length === 0) {
    throw new Error("No jobs found. Run `npm run seed` first.");
  }
  const job = jobsData.jobs[0];
  console.log(`Using job: ${job.title} at ${job.company} (${job.id})`);

  console.log("POST /api/match ...");
  const matchRes = await fetch(`${BASE_URL}/api/match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: job.id }),
  });
  const matchData = await matchRes.json();
  if (!matchRes.ok) {
    throw new Error(`Match request failed (${matchRes.status}): ${JSON.stringify(matchData)}`);
  }

  const m = matchData.matchResult;
  console.log(`Eligibility: ${m.eligibility}`);
  console.log(`Score: ${m.score}`);
  console.log(`Explanation: ${m.explanation}`);

  if (!["Pass", "Fail", "Unknown"].includes(m.eligibility)) {
    throw new Error(`Unexpected eligibility value: ${m.eligibility}`);
  }
  if (typeof m.score !== "number" || m.score < 0 || m.score > 100) {
    throw new Error(`Score out of range: ${m.score}`);
  }

  const supported = JSON.parse(m.skillsSupported);
  const needConfirm = JSON.parse(m.skillsNeedConfirmation);
  const toLearn = JSON.parse(m.skillsToLearn);
  const neverAdd = JSON.parse(m.skillsNeverAdd);
  console.log(`Skills supported: ${supported.length}, need confirmation: ${needConfirm.length}, to learn: ${toLearn.length}, never add: ${neverAdd.length}`);

  for (const item of supported) {
    if (!Array.isArray(item.factIds) || item.factIds.length === 0) {
      throw new Error(`Skill "${item.skill}" marked as supported but has no cited fact ids.`);
    }
  }

  console.log("\nJob creation + scoring test PASSED.");
}

main().catch((err) => {
  console.error("\nJob scoring test FAILED:", err.message);
  process.exitCode = 1;
});
