import { Suspense } from "react";
import ChartExplorer from "@/components/ChartExplorer";

export default function ChartsPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted">Loading charts…</p>}>
      <ChartExplorer />
    </Suspense>
  );
}
