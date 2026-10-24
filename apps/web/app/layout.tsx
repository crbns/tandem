import type { Metadata } from "next";
import localFont from "next/font/local";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
// Self-hosted from npm (OFL): no build-time fetch from Google, which breaks
// Turbopack production builds and offline Docker builds.
import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/500.css";
import "@fontsource/public-sans/600.css";
import "@fontsource/public-sans/700.css";
import "@fontsource/archivo-narrow/500.css";
import "@fontsource/archivo-narrow/600.css";
import "./globals.css";
import { Providers } from "./providers";
import { Toaster } from "@/components/ui/sonner";
import { USE_MOCKS } from "@/lib/config";

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Tandem",
  description: "Shared files for people. Shared understanding for their AI assistants.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const document = (
    <html lang="en">
      <body className={`${geistMono.variable} font-sans`}>
        <Providers>{children}</Providers>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );

  if (USE_MOCKS) return document;
  return <ConvexAuthNextjsServerProvider>{document}</ConvexAuthNextjsServerProvider>;
}
