import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dukaan MCP — merchant onboarding",
  description:
    "Turn a product CSV and a policy into an agent-transactable storefront. Built by @dharminnagar",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#fafafa] text-[#1a1a1a] antialiased">
        {children}
      </body>
    </html>
  );
}
