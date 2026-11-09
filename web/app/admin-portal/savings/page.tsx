import type { Metadata } from "next";
import { SavingsAdminView } from "@/components/admin/views/SavingsAdminView";

export const metadata: Metadata = {
  title: "Bloques de Ahorro",
};

export default function SavingsPage() {
  return <SavingsAdminView />;
}
