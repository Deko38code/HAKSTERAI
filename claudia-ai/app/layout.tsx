import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claudia AI - AI Application Builder",
  description: "Build applications with the power of AI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
