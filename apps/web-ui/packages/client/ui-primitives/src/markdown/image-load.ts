/** Retry/reload cache-busting keys for owner-resolved local Markdown images. */
let imageLoads = 0;

// Tree-position IDs can repeat between sessions; a module counter cannot.
export const nextImageLoad = (): number => ++imageLoads;

/**
 * Append a cache-busting `load` tag to an owner-resolved local image URL when
 * retrying after a load failure or performing an explicit reload. Normal mounts
 * omit `load` (or pass `0`) so WebKit/browsers keep a single cached entry per
 * URL and revalidate via `ETag` / `304 Not Modified`.
 * @param url - Owner-resolved absolute URL; authored remote URLs do not use this helper.
 * @param load - Optional positive retry/reload counter; absent or non-positive keeps `url` stable.
 * @returns The stable URL by default, or the URL with a `load` tag preserving data/blob URLs and existing query encoding.
 */
export function freshImageUrl(url: string, load?: number): string {
  if (load === undefined || !Number.isFinite(load) || load <= 0) return url;
  let fresh: URL;
  try {
    fresh = new URL(url);
  } catch {
    return url;
  }
  if (fresh.protocol === "data:" || fresh.protocol === "blob:") return url;
  fresh.search = `${fresh.search === "" ? "?" : `${fresh.search}&`}load=${Math.floor(load)}`;
  return fresh.href;
}
