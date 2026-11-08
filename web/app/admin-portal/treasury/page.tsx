import type { Metadata } from "next";
import { TreasuryView } from "@/components/admin/views/TreasuryView";

export const metadata: Metadata = { title: "Tesorería" };

export default function Page() {
  return <TreasuryView />;
}
