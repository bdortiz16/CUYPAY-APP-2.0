import type { Metadata } from "next";
import { UsersView } from "@/components/admin/views/SystemViews";

export const metadata: Metadata = { title: "Usuarios admin" };

export default function Page() {
  return <UsersView />;
}
