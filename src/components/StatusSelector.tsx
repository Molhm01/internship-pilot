"use client";

import { STATUS_LABELS, TRACKER_STATUSES } from "@/lib/statuses";

export default function StatusSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (status: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="input-sm font-medium"
    >
      {TRACKER_STATUSES.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABELS[s]}
        </option>
      ))}
    </select>
  );
}
