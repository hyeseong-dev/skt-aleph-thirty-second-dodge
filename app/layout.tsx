import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '30초 피하기',
  description: '방향키로 장애물을 피하고 30초 동안 생존하는 브라우저 미니게임',
  icons: { icon: '/favicon.svg' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
