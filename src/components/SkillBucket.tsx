export type SkillItem = { skill: string; reason: string; factIds?: string[] };

const STYLES: Record<string, { dot: string; title: string; description: string }> = {
  supported: {
    dot: "bg-emerald-500",
    title: "Already supported by your resume",
    description: "Directly backed by an approved fact.",
  },
  confirm: {
    dot: "bg-amber-500",
    title: "Missing or unconfirmed qualifications",
    description: "Related evidence may exist, but this is not a confirmed qualification.",
  },
  learn: {
    dot: "bg-sky-500",
    title: "Skills to learn",
    description: "Not evidenced yet, but reasonable to pick up.",
  },
  never: {
    dot: "bg-rose-500",
    title: "Never claim these",
    description: "No evidence you've used these — do not add them to an application.",
  },
};

export default function SkillBucket({
  variant,
  items,
}: {
  variant: keyof typeof STYLES;
  items: SkillItem[];
}) {
  const style = STYLES[variant];
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full ${style.dot}`} />
        <h3 className="text-sm font-semibold text-slate-800">{style.title}</h3>
      </div>
      <p className="text-xs text-slate-500 mb-3">{style.description}</p>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400 italic">None</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item, i) => (
            <li key={i} className="text-sm">
              <span className="font-medium text-slate-800">{item.skill}</span>
              <p className="text-xs text-slate-500">{item.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
