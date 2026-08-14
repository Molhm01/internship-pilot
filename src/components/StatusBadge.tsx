import { STATUS_COLORS, STATUS_LABELS, TrackerStatus } from "@/lib/statuses";

export default function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status as TrackerStatus] ?? "bg-n-150 text-secondary border-line";
  const label = STATUS_LABELS[status as TrackerStatus] ?? status;
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}
