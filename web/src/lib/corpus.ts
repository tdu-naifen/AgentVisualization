// corpus.ts — load the packed corpus (public/corpus.json) at runtime.
import type { Doc } from '@/types';

/**
 * Derive the GitHub Pages basePath when the caller doesn't pass one.
 * Next inlines the configured `basePath` into the client bundle via this env
 * var at build time, so on a project page (served under /<repo>/) this returns
 * "/<repo>" and the corpus fetch resolves correctly. Locally it returns "".
 */
function defaultBasePath(): string {
  if (
    typeof process !== 'undefined' &&
    process.env &&
    process.env.__NEXT_ROUTER_BASEPATH
  ) {
    return process.env.__NEXT_ROUTER_BASEPATH as string;
  }
  return '';
}

/** Fetch the packed corpus at runtime. basePath handles GitHub Pages subpath (defaults to the build-time basePath). */
export async function loadCorpus(basePath: string = defaultBasePath()): Promise<Doc[]> {
  const url = `${basePath}/corpus.json`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`loadCorpus: network error fetching ${url}: ${reason}`);
  }

  if (!res.ok) {
    throw new Error(
      `loadCorpus: failed to fetch ${url} (HTTP ${res.status} ${res.statusText})`,
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`loadCorpus: invalid JSON in ${url}: ${reason}`);
  }

  if (!Array.isArray(data)) {
    throw new Error(`loadCorpus: ${url} did not contain a JSON array`);
  }

  return data as Doc[];
}
