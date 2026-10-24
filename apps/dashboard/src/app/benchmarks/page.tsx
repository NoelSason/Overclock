import type { Metadata } from "next";
import { BenchmarkList } from "@/components/benchmarks/benchmark-list";

export const metadata: Metadata = { title: "Benchmarks" };

export default function BenchmarksPage() {
  return <BenchmarkList />;
}
