import { Suspense } from "react";
import TransactionsManager from "@/components/TransactionsManager";

export default function TransactionsPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted">Loading activity…</p>}>
      <TransactionsManager />
    </Suspense>
  );
}
