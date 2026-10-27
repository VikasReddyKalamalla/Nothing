import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '../contexts/AuthContext';

export const metadata: Metadata = {
  title: 'Auris — AI Phone Agents & Telecalling Platform',
  description:
    'Enterprise AI voice-agent telecalling platform for instant leads, bulk campaigns, and 24/7 inbound reception.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
