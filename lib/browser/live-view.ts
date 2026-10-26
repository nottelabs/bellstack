export function toEmbeddedNotteLiveViewUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    const apiOrigin = new URL(process.env.NOTTE_API_URL ?? "https://api.notte.cc");
    const hosts = new Set(["console.notte.cc", apiOrigin.hostname]);
    if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.pathname !== "/static/viewer" || url.username || url.password || !url.searchParams.has("jwt")) return;
    return url.href;
  } catch { return; }
}
