import type { Metadata } from "next";
import { BenchmarkDetail } from "@/components/benchmarks/benchmark-detail";

type Props = { params: Promise<{ name: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name } = await params;
  return { title: decodeURIComponent(name) };
}

export default async function BenchmarkPage({ params }: Props) {
  const { name } = await params;
  return <BenchmarkDetail name={decodeURIComponent(name)} />;
}
