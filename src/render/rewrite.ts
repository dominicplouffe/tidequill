/**
 * Rewrites root-relative URLs in rendered HTML (href, src, srcset, form
 * actions, data-index and CSS url()) so a page can be served under a prefix:
 * /_site/<id>/ previews and /live/<id>/ editing on the admin host.
 */
export function rewriteRootUrls(html: string, map: (path: string) => string): string {
  const one = (p: string) => (p.startsWith("/") && !p.startsWith("//") ? map(p) : p);
  return html
    .replace(/(\s(?:href|src|action|data-index)=")([^"]*)"/g, (_, pre: string, url: string) => `${pre}${one(url)}"`)
    .replace(/(\ssrcset=")([^"]*)"/g, (_, pre: string, set: string) => `${pre}${set.split(",").map((part) => part.trim().replace(/^(\S+)/, (u) => one(u))).join(", ")}"`)
    .replace(/url\((\/[^)/][^)]*|\/)\)/g, (_, url: string) => `url(${one(url)})`);
}

export function prefixUrls(html: string, basePath: string): string {
  const base = basePath.replace(/\/$/, "");
  return rewriteRootUrls(html, (p) => `${base}${p}`);
}
