import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { HealthProvider } from "@/components/health";
import { Nav } from "@/components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Overclock", template: "%s · Overclock" },
  description: "Live console for compiled, verified browser execution.",
};

export const viewport: Viewport = { themeColor: "#080a0d", colorScheme: "dark" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <HealthProvider>
          <Nav />
          <main className="px-3 py-3 sm:px-4">{children}</main>
        </HealthProvider>
      </body>
    </html>
  );
}
