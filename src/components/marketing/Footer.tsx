import Link from "next/link";
import { Wordmark } from "@/components/shell/Wordmark";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { href: "#product", label: "Overview" },
      { href: "#how-it-works", label: "How it works" },
      { href: "/jobs", label: "Discover internships" },
    ],
  },
  {
    heading: "Agent",
    links: [
      { href: "#agent", label: "How the Agent works" },
      { href: "#architecture", label: "Architecture" },
      { href: "#privacy", label: "Local AI & privacy" },
    ],
  },
  {
    heading: "Project",
    links: [
      { href: "#status", label: "Status & roadmap" },
      { href: "#journey", label: "Engineering notes" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto max-w-6xl px-5 py-12 lg:px-8">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="space-y-3">
            <Wordmark />
            <p className="max-w-xs text-small text-tertiary">
              Internship discovery, matching, and application assistance for engineering students.
              Runs locally on your own machine.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.heading} className="space-y-2.5">
              <p className="text-micro font-medium uppercase tracking-[0.075em] text-faint">
                {column.heading}
              </p>
              <ul className="space-y-1.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-small text-secondary transition-colors duration-[120ms] ease-standard hover:text-primary"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-hairline pt-5 text-micro text-faint sm:flex-row sm:items-center sm:justify-between">
          <p>
            Internship Pilot — a personal engineering project, in active development. Not
            affiliated with any employer or applicant tracking system named in the interface.
          </p>
          <p className="font-mono">Local-first · Ollama · SQLite</p>
        </div>
      </div>
    </footer>
  );
}
