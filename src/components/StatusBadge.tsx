import { STATUS_COLORS, STATUS_LABELS, TrackerStatus } from "@/lib/statuses";

export default function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status as TrackerStatus] ?? "bg-slate-100 text-slate-700 border-slate-300";
  const label = STATUS_LABELS[status as TrackerStatus] ?? status;
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}
