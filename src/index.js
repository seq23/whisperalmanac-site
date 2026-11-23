// whisperalmanac.com has one address: https on the bare domain. Plain http and www get a
// permanent redirect there (same path and query), so search engines index one copy.
// Everything else is the static site in ./public (404s get public/404.html).
export const CANONICAL_HOST = 'whisperalmanac.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Only the site's own hosts are redirected; *.workers.dev previews and local dev pass through.
    const ours = url.hostname === CANONICAL_HOST || url.hostname === `www.${CANONICAL_HOST}`;
    if (ours && (url.protocol !== 'https:' || url.hostname !== CANONICAL_HOST)) {
      url.protocol = 'https:';
      url.hostname = CANONICAL_HOST;
      url.port = '';
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
