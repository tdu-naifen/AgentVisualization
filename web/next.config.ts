import type { NextConfig } from 'next';

// Static export so the whole app is plain HTML/JS deployable to GitHub Pages.
// No server, no API routes — transformers.js runs the model fully client-side.
const repo = 'AgentVisualization'; // TODO(deploy): confirm this matches your GitHub repo name (the path after github.com/<user>/)
const isProd = process.env.NODE_ENV === 'production';

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  // On GitHub Pages project sites the app is served under /<repo>/.
  basePath: isProd ? `/${repo}` : '',
  assetPrefix: isProd ? `/${repo}/` : '',
  // transformers.js pulls wasm/onnx assets; keep trailing slash stable for static hosting.
  trailingSlash: true,
};

// Exposed for any app code that needs the deploy subpath. NOTE: prefer reading
// the basePath at runtime (see src/lib/corpus.ts) over importing this module
// into the client bundle.
export const BASE_PATH = isProd ? `/${repo}` : '';

export default nextConfig;
