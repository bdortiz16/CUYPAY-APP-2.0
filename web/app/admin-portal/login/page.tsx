import type { Metadata } from "next";
import { LoginView } from "@/components/admin/views/LoginView";

export const metadata: Metadata = { title: "Iniciar sesión" };

export default function Page() {
  return <LoginView />;
}
