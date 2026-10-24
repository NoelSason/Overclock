import type { Metadata } from "next";
import { RunList } from "@/components/runs/run-list";

export const metadata: Metadata = { title: "Runs" };

export default function RunsPage() {
  return <RunList />;
}
