// Anonymous canvas/fetch reads apply only to immutable wallpaper images, never other downloads.
const IMAGE_PATH = /^\/code\/wallpapers\/v[0-9]+\/[a-z0-9-]+-[a-f0-9]{16}\.webp$/;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!IMAGE_PATH.test(url.pathname)) return new Response(null, { status: 404 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } });
    const key = url.pathname.slice(1);
    const object =
      request.method === "HEAD" ? await env.WALLPAPERS.head(key) : await env.WALLPAPERS.get(key);
    if (!object) return new Response(null, { status: 404, headers: cors });
    return new Response(request.method === "HEAD" ? null : object.body, {
      headers: {
        ...cors,
        "Content-Type": "image/webp",
        "Content-Length": String(object.size),
        "Cache-Control": "public, max-age=31536000, immutable",
        "ETag": object.httpEtag,
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
};
