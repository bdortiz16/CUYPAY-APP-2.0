import type { Metadata } from "next";
import { Suspense } from "react";
import { TransactionsView } from "@/components/admin/views/TransactionsView";

export const metadata: Metadata = { title: "Transacciones" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <TransactionsView />
    </Suspense>
  );
}
