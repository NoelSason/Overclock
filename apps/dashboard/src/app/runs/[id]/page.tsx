import type { Metadata } from "next";
import { CommandBar } from "@/components/console/command-bar";
import { RunConsole } from "@/components/console/run-console";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Run ${decodeURIComponent(id)}` };
}

export default async function RunPage({ params }: Props) {
  const { id } = await params;
  const runId = decodeURIComponent(id);
  return (
    <div className="flex flex-col gap-3">
      <CommandBar defaultOpen={false} />
      <RunConsole key={runId} runId={runId} />
    </div>
  );
}
