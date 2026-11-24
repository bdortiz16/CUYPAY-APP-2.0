import type { Metadata } from "next";
import { Suspense } from "react";
import { CardsAdminView } from "@/components/admin/views/CardsAdminView";

export const metadata: Metadata = {
  title: "Tarjetas virtuales",
};

export default function CardsPage() {
  return (
    <Suspense fallback={null}>
      <CardsAdminView />
    </Suspense>
  );
}
