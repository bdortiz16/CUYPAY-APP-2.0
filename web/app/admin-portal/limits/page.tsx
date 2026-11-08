import type { Metadata } from "next";
import { LimitsView } from "@/components/admin/views/SystemViews";

export const metadata: Metadata = { title: "Límites" };

export default function Page() {
  return <LimitsView />;
}
