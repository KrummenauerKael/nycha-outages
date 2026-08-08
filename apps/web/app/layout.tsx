import { Analytics } from '@vercel/analytics/next';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Deliberately unstyled.
 *
 * There is no design system here yet and none is implied — no fonts, colours,
 * spacing, or CSS reset. The visual language gets derived from the subject when
 * the UI is designed; anything chosen now would only have to be argued with
 * later. Structure and data flow are what this scaffold is for.
 */
export const metadata: Metadata = {
  title: 'NYCHA service interruption archive',
  description:
    'Hourly archive of NYCHA heat, hot water, water, elevator, electric, and gas service interruptions.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        {/*
          Web Analytics only — audience, not Speed Insights. Cookieless and
          with no per-visitor identifier, which is the right posture for a site
          whose subject is people's living conditions: knowing whether anyone
          reads this is useful, knowing who they are is not.
        */}
        <Analytics />
      </body>
    </html>
  );
}
