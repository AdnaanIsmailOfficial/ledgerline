import type { Metadata } from "next";
import { PolicyViewer } from "@/components/policy-viewer";

export const metadata: Metadata = { title: "Policies · Ledgerline" };

export default function PoliciesPage() {
  return <PolicyViewer />;
}
