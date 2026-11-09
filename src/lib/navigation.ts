/** Only product routes can be used as a post-login destination. */
export function returnPath(value: string | null): string {
  if (!value || /[\\\u0000-\u0020]/.test(value)) return "/overview";
  try {
    const url = new URL(value, "http://local.test");
    if (!value.startsWith("/") || url.origin !== "http://local.test" || url.hash ||
      !/^\/(overview|players(?:\/[1-9]\d{0,17})?|compare|admin|account)$/.test(url.pathname)) return "/overview";
    return url.pathname + url.search;
  } catch { return "/overview"; }
}
