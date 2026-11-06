import type { Metadata } from 'next';
import './style.css';

export const metadata: Metadata = { title: 'آبیاری هوشمند', description: 'نمایش وضعیت آبیاری گیاه' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="fa" dir="rtl"><body>{children}</body></html>;
}
