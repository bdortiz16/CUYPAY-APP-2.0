import type { Metadata } from "next";
import { Suspense } from "react";
import { CustomersView } from "@/components/admin/views/CustomersView";

export const metadata: Metadata = { title: "Clientes" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CustomersView />
    </Suspense>
  );
}
