import type { Metadata } from "next";
import { ProvidersView } from "@/components/admin/views/SystemViews";

export const metadata: Metadata = { title: "Conexiones" };

export default function Page() {
  return <ProvidersView />;
}
