import { PrelaunchGate } from "@/components/Prelaunch";
import type { Metadata, Viewport } from "next";
import { Archivo, Geist } from "next/font/google";
import { AnnouncementBar, Footer, Header } from "@/components/chrome";
import { MotionRoot } from "@/components/motion";
import { SoundProvider } from "@/components/sound";
import { WalletProvider } from "@/lib/wallet";
import { BRAND } from "@/lib/config";
import "./globals.css";
import "./frontier.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
// Archivo's width axis (62–125%) gives the extended grotesk of the display type.
const display = Archivo({ subsets: ["latin"], variable: "--font-display", axes: ["wdth"], display: "swap" });

const SITE_BIO = "Sealed-bid block trades for Robinhood Chain stock tokens. No price shown, no counterparty risk. Every fee burns $FORGE. forgetrade.sbs";

export const metadata: Metadata = {
  title: { default: `${BRAND.name} · ${BRAND.tagline}`, template: `%s · ${BRAND.name}` },
  description: SITE_BIO,
  openGraph: { title: `${BRAND.name} · ${BRAND.tagline}`, description: SITE_BIO, url: "https://forgetrade.sbs", siteName: BRAND.name, type: "website" },
  twitter: { card: "summary_large_image", title: `${BRAND.name} · ${BRAND.tagline}`, description: SITE_BIO },
  referrer: "no-referrer",
};

export const viewport: Viewport = { themeColor: "#080808", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body>
        <WalletProvider>
          <SoundProvider>
            <MotionRoot>
              <AnnouncementBar />
              <Header />
              <main><PrelaunchGate>{children}</PrelaunchGate></main>
              <Footer />
            </MotionRoot>
          </SoundProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
