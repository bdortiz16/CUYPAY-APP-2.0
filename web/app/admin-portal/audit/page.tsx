import type { Metadata } from "next";
import { AuditView } from "@/components/admin/views/SystemViews";

export const metadata: Metadata = { title: "Audit log" };

export default function Page() {
  return <AuditView />;
}
