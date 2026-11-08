import type { Metadata } from "next";
import { DashboardView } from "@/components/admin/views/DashboardView";

export const metadata: Metadata = { title: "Resumen" };

export default function Page() {
  return <DashboardView />;
}
