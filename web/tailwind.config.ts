import type { Config } from 'tailwindcss';

// everswap-inspired dark-neon palette (see PRODUCT_DECISIONS.md).
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: { base: '#0a0e14', panel: '#0d1420', card: '#15161a' },
        line: '#1a2433',
        ink: { base: '#c4d2e0', dim: '#8aa0b8', faint: '#5a6b80' },
        // four-block accents: context / thinking / decision / observation
        ctx: '#22d3ee',
        think: '#fbbf24',
        decide: '#2dd4bf',
        observe: '#f472b6',
        // tool-use: the agent loop's OWN action (the parsed tool call the harness
        // executes). A dedicated violet — distinct from the teal 'decide' (which is
        // the model's reasoning/answer) — used consistently for the parsed-tool-call
        // block across every agent scenario (02/04/06). Tool use is the one place the
        // model reaches OUT and acts, so it earns its own color.
        tool: '#a78bfa',
        // semantic red for leaks / PII / hard failures (distinct from pink observe)
        danger: '#f87171',
      },
      boxShadow: {
        neon: '0 4px 20px rgba(45,212,191,0.27)',
        thinkglow: '0 0 16px rgba(251,191,36,0.18)',
      },
      backgroundImage: {
        'app': 'linear-gradient(160deg,#0a0e14 0%,#0d1420 100%)',
        'accent': 'linear-gradient(90deg,#2dd4bf,#22d3ee)',
      },
    },
  },
  plugins: [],
};
export default config;
