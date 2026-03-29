import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "De-Influencer SMS",
  description: "Roasts for purchases you don't need.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

