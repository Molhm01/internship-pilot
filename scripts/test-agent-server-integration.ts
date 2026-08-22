import "dotenv/config";
import { prisma } from "@/lib/db";
import { buildExtensionFillPlan } from "@/lib/applications/extensionApi";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else { console.error(`  FAIL: ${message}`); failures += 1; }
}

const PREFIX = "agent-server-audit";

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIX } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await prisma.job.deleteMany({ where: { company: "Agent Server Audit Co" } });
}

async function createUser(suffix: string) {
  const user = await prisma.user.create({
    data: { email: `${PREFIX}-${suffix}@example.com`, name: `Audit ${suffix}`, emailVerified: true },
  });
  await prisma.userProfile.create({
    data: {
      userId: user.id,
      legalFirstName: "Audit",
      legalLastName: suffix,
      applicationEmail: `${PREFIX}-${suffix}@example.com`,
      phone: "+12025550123",
      city: "Newark",
      state: "NJ",
      country: "United States",
    },
  });
  await prisma.education.create({
    data: { userId: user.id, school: "NJIT", degree: "B.S.", major: "Electrical Engineering", graduationYear: "2028" },
  });
  return user;
}

async function main() {
  await cleanup();
  const owner = await createUser("Owner");
  const stranger = await createUser("Stranger");
  const job = await prisma.job.create({
    data: {
      title: "Electrical Engineering Intern",
      company: "Agent Server Audit Co",
      description: "Release fixture for the authenticated server-to-agent boundary.",
      source: "greenhouse",
      url: "https://boards.greenhouse.io/agentserveraudit/jobs/123",
      officialApplyUrl: "https://boards.greenhouse.io/agentserveraudit/jobs/123",
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      activeFeed: true,
    },
  });
  const resume = await prisma.generatedDocument.create({
    data: {
      userId: owner.id,
      jobId: job.id,
      type: "resume",
      version: 1,
      storagePath: `data/generated/${job.id}/resume-v1.pdf`,
      qaStatus: "pass",
      tailoringStatus: "MASTER_RESUME_FALLBACK",
      identityVerified: true,
      bulletIdsUsed: "[]",
    },
  });
  const run = await prisma.applicationRun.create({
    data: {
      userId: owner.id,
      activeKey: `${owner.id}:${job.id}`,
      jobId: job.id,
      mode: "fill_to_submit",
      atsType: "greenhouse",
      status: "queued",
      resumeDocumentId: resume.id,
    },
  });

  console.log("1) Owner can obtain a fill plan from the website integration API layer");
  const plan = await buildExtensionFillPlan(
    {
      runId: run.id,
      pageUrl: "https://boards.greenhouse.io/agentserveraudit/jobs/123/application",
      pageTitle: "Application",
      blockers: [],
      fields: [
        {
          index: 0,
          label: "Email",
          groupLabel: "",
          optionLabel: "",
          name: "email",
          id: "email",
          ariaLabel: "Email",
          placeholder: "",
          nearbyText: "Email",
          role: "",
          type: "email",
          required: true,
          options: [],
          currentValue: "",
        },
        {
          index: 1,
          label: "I certify the information above is accurate",
          groupLabel: "",
          optionLabel: "",
          name: "certify",
          id: "certify",
          ariaLabel: "",
          placeholder: "",
          nearbyText: "Certification",
          role: "",
          type: "checkbox",
          required: true,
          options: [],
          currentValue: "",
        },
      ],
    },
    owner.id,
  );
  check(plan.runId === run.id, "fill plan is tied to the requested ApplicationRun");
  const emailInstruction = plan.fields.find((field) => field.index === 0);
  check(emailInstruction?.action === "fill", `ordinary identity field is fillable (got ${emailInstruction?.action})`);
  check("value" in (emailInstruction ?? {}) && (emailInstruction as { value?: string }).value === `${PREFIX}-Owner@example.com`, "fill value comes from the owner's user-scoped profile");
  const legalInstruction = plan.fields.find((field) => field.index === 1);
  check(legalInstruction?.action === "leave_for_user", "legal/certification field remains explicitly user-reviewed");

  console.log("\n2) Another signed-in user cannot obtain the owner's run or resume");
  let blocked = false;
  try {
    await buildExtensionFillPlan(
      {
        runId: run.id,
        pageUrl: "https://boards.greenhouse.io/agentserveraudit/jobs/123/application",
        pageTitle: "Application",
        blockers: [],
        fields: [{
          index: 0, label: "Email", groupLabel: "", optionLabel: "", name: "email", id: "email",
          ariaLabel: "Email", placeholder: "", nearbyText: "Email", role: "", type: "email", required: true,
          options: [], currentValue: "",
        }],
      },
      stranger.id,
    );
  } catch (error) {
    blocked = error instanceof Error && /could not find this ApplicationRun/i.test(error.message);
  }
  check(blocked, "cross-user run access is rejected before profile/document data is returned");

  console.log("\n3) Integration remains fill-to-review, not auto-submit");
  check(!plan.fields.some((field) => field.action === "submit"), "server fill plan contains no final-submit instruction");

  await cleanup();
  console.log(failures === 0 ? "\nAll server-to-agent integration tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures) process.exitCode = 1;
}

void main()
  .catch((error) => { console.error("Server-to-agent integration test crashed:", error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
