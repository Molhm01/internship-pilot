import { DashboardClient } from "./DashboardClient";
import { hasGeminiApiKey } from "@/lib/gemini";

export const metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return <DashboardClient scoringConfigured={hasGeminiApiKey()} />;
}
