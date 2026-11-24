// The SECURITY contract: every runtime response refuses frames, including the
// asset responses that send their own CSP (HTML sandbox, SVG, downloads).
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "vitest";

import { assetResponseHeaders } from "../http.ts";
import { denyFraming } from "./index.ts";

test("responses with their own CSP still carry frame-ancestors 'none' and X-Frame-Options DENY", async () => {
  const cases: Record<string, Record<string, string>> = {
    "/page.html": assetResponseHeaders("page.html"),
    "/image.svg": assetResponseHeaders("image.svg"),
    "/download": assetResponseHeaders("page.html", { download: true, mimeType: "text/html" }),
    "/plain": {},
    "/own-ancestors": { "Content-Security-Policy": "frame-ancestors http://127.0.0.1:1" },
  };
  // Effect's NodeHttpServer writes headers the same way: writeHead(status, statusText, headers).
  const server = denyFraming(http.createServer((request, response) => {
    response.writeHead(200, undefined, cases[request.url ?? ""]);
    response.end("x");
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const csp: Record<string, string | null> = {};
    for (const route of Object.keys(cases)) {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`);
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      csp[route] = response.headers.get("content-security-policy");
    }
    expect(csp).toEqual({
      "/page.html": `${cases["/page.html"]!["Content-Security-Policy"]}; frame-ancestors 'none'`,
      "/image.svg": `${cases["/image.svg"]!["Content-Security-Policy"]}; frame-ancestors 'none'`,
      "/download": `${cases["/download"]!["Content-Security-Policy"]}; frame-ancestors 'none'`,
      "/plain": "frame-ancestors 'none'",
      "/own-ancestors": "frame-ancestors http://127.0.0.1:1",
    });
    expect(csp["/page.html"]).toMatch(/^sandbox allow-scripts/);
  } finally {
    server.close();
  }
});
