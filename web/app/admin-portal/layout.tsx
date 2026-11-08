import type { Metadata } from "next";
import { AdminRoot } from "@/components/admin/AdminShell";

export const metadata: Metadata = {
  title: { default: "Back-office", template: "%s · CuyPay Admin" },
  description: "Portal interno de CuyPay.",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminRoot>{children}</AdminRoot>;
}
