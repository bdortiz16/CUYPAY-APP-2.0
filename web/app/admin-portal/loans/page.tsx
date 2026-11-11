import type { Metadata } from "next";
import { LoansAdminView } from "@/components/admin/views/LoansAdminView";

export const metadata: Metadata = {
  title: "Préstamos y Pagarés",
};

export default function LoansPage() {
  return <LoansAdminView />;
}
