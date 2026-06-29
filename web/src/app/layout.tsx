import type { Metadata } from 'next';
import { JetBrains_Mono, Share_Tech_Mono } from 'next/font/google';
import '@/styles/globals.css';

// Body: JetBrains Mono (dense, legible). Display: Share Tech Mono — the tall,
// narrow terminal face used for the title + section headings (Modal-glossary look).
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });
const display = Share_Tech_Mono({ subsets: ['latin'], weight: '400', variable: '--font-display', display: 'swap' });

export const metadata: Metadata = {
  title: 'Agent vs Workflow Explainer',
  description: 'Watch an LLM agent loop run, step by step, in your browser (WebGPU).',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="terminal" className={`${mono.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
