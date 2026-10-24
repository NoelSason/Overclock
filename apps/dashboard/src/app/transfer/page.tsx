import type { Metadata } from "next";
import { TransferStory } from "@/components/transfer/transfer-story";

export const metadata: Metadata = { title: "Transfer" };

export default function TransferPage() {
  return <TransferStory />;
}
