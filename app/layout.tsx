import Script from "next/script";
import type { ReactNode } from "react";

export const metadata = {
  title: "Dashboard Penanganan Perkara",
  description: "Ruang kerja penanganan perkara"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="id">
      <head>
        <meta name="theme-color" content="#171516" />
        <link rel="stylesheet" href="/styles.css" />
        <link rel="stylesheet" href="/account.css" />
        <link rel="stylesheet" href="/workflow.css" />
        <link rel="stylesheet" href="/brand-theme.css" />
      </head>
      <body>
        {children}
        <Script src="/app.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
