import type { Metadata } from "next";
import { Suspense } from "react";
import { ComplianceView } from "@/components/admin/views/ComplianceView";

export const metadata: Metadata = { title: "Cumplimiento" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ComplianceView />
    </Suspense>
  );
}
