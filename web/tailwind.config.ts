import type { Config } from 'tailwindcss';

// Tokens repoint to CSS variables (set per <html data-theme>) so the 3 themes —
// terminal / light-green / light — drive every component. Palette: Modal GPU
// glossary terminal aesthetic. RGB split so /opacity utilities keep working.
const v = (name: string) => `rgb(var(${name}) / <alpha-value>)`;
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: { base: v('--bg-base'), panel: v('--bg-panel'), card: v('--bg-card') },
        line: v('--line'),
        ink: { base: v('--ink-base'), dim: v('--ink-dim'), faint: v('--ink-faint') },
        // state accents (teaching meaning preserved; tuned per theme via vars)
        ctx: v('--ctx'),
        think: v('--think'),
        decide: v('--decide'),
        observe: v('--observe'),
        tool: v('--tool'),
        danger: v('--danger'),
      },
      fontFamily: {
        mono: ['var(--font-mono)', 'JetBrains Mono', 'ui-monospace', 'monospace'],
        display: ['var(--font-display)', 'Share Tech Mono', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        neon: '0 0 18px rgb(var(--decide) / 0.35)',
        thinkglow: '0 0 16px rgb(var(--think) / 0.20)',
      },
      backgroundImage: {
        app: 'var(--bg-app)',
        accent: 'var(--bg-accent)',
      },
    },
  },
  plugins: [],
};
export default config;
