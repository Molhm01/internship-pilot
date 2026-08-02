import "dotenv/config";
import { prisma } from "@/lib/db";

async function main() {
  console.log("Clearing existing sample data...");
  await prisma.matchResult.deleteMany();
  await prisma.job.deleteMany();
  await prisma.resumeFact.deleteMany();

  console.log("Seeding approved resume facts...");
  await prisma.resumeFact.createMany({
    data: [
      {
        type: "education",
        content: "B.S. in Computer Science, State University",
        detail: "Expected graduation May 2027",
        status: "approved",
        source: "manual",
      },
      { type: "gpa", content: "3.7 GPA", status: "approved", source: "manual" },
      {
        type: "graduationDate",
        content: "May 2027",
        status: "approved",
        source: "manual",
      },
      {
        type: "coursework",
        content: "Data Structures and Algorithms",
        status: "approved",
        source: "manual",
      },
      { type: "coursework", content: "Database Systems", status: "approved", source: "manual" },
      { type: "skill", content: "Python", detail: "Used in 3 course projects", status: "approved", source: "manual" },
      { type: "skill", content: "JavaScript", detail: "Used to build a personal portfolio site", status: "approved", source: "manual" },
      { type: "skill", content: "SQL", detail: "Used in Database Systems coursework", status: "approved", source: "manual" },
      { type: "skill", content: "Git", status: "approved", source: "manual" },
      {
        type: "project",
        content: "Built a course-scheduling web app",
        detail: "React frontend, Node/Express backend, PostgreSQL database, for a class project",
        status: "approved",
        source: "manual",
      },
      {
        type: "experience",
        content: "IT Help Desk Assistant, University IT Services",
        detail: "Part-time, Sept 2025 - present. Troubleshoot hardware/software issues for students and staff.",
        status: "approved",
        source: "manual",
      },
      {
        type: "activity",
        content: "Member, Computer Science Club",
        status: "approved",
        source: "manual",
      },
    ],
  });

  console.log("Seeding sample jobs...");
  await prisma.job.create({
    data: {
      title: "Software Engineering Intern",
      company: "Northwind Analytics",
      location: "Remote",
      internshipTerm: "Summer 2027",
      duration: "12 weeks",
      url: "https://example.com/careers/swe-intern",
      status: "DISCOVERED",
      postingDate: new Date("2026-06-01"),
      description: `Northwind Analytics is looking for a Software Engineering Intern for Summer 2027.

Requirements:
- Currently pursuing a B.S. in Computer Science or related field
- Minimum 3.3 GPA
- Experience with Python or JavaScript
- Familiarity with SQL and relational databases
- Comfortable with Git version control
- Nice to have: experience with React and Node.js
- Nice to have: exposure to cloud platforms (AWS/GCP/Azure)

Responsibilities:
- Build features for our internal analytics dashboard
- Write unit tests and participate in code review
- Collaborate with a small team of engineers`,
    },
  });

  await prisma.job.create({
    data: {
      title: "Senior Backend Engineering Intern",
      company: "Fintrust Systems",
      location: "New York, NY",
      internshipTerm: "Summer 2027",
      duration: "10 weeks",
      url: "https://example.com/careers/backend-intern",
      status: "VERIFIED",
      postingDate: new Date("2026-05-15"),
      description: `Fintrust Systems is hiring a Backend Engineering Intern.

Requirements:
- Minimum 3.5 GPA
- 2+ years of professional experience with distributed systems
- Deep expertise in Kubernetes and Kafka
- Must be authorized to work in the US without sponsorship
- Experience with Java or Go in production environments

Responsibilities:
- Own a service in our payments processing pipeline
- On-call rotation participation`,
    },
  });

  await prisma.job.create({
    data: {
      title: "Data Science Intern",
      company: "Bright Path Labs",
      location: "Austin, TX",
      internshipTerm: "Fall 2026",
      duration: "16 weeks",
      status: "DISCOVERED",
      postingDate: new Date("2026-07-01"),
      description: `Bright Path Labs seeks a Data Science Intern for Fall 2026.

Requirements:
- Pursuing a degree in CS, Statistics, or related field
- Experience with Python and SQL
- Coursework in data structures/algorithms preferred
- Strong communication skills

Responsibilities:
- Analyze internal datasets and build reporting dashboards
- Present findings to stakeholders`,
    },
  });

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

