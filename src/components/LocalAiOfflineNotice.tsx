"use client";

/**
 * Cloud and local runtimes both support autonomous matching, PDF tailoring,
 * and remote/local application execution, so this notice renders nothing.
 */
export default function LocalAiOfflineNotice({
  feature,
  className = "",
}: {
  feature: string;
  className?: string;
}) {
  void feature;
  void className;
  return null;
}
