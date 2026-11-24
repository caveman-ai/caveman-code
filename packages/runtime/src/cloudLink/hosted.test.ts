// Which hosts a Cloud's sign-in may send to: Caveman's hosted Cloud keeps Caveman's gateway; any other Cloud gets
// only the gateway it named itself, never a Caveman host and never a fallback to one.
import { CREDITS_GATEWAY_URL } from "@caveman-app/provider-caveman/server";
import { expect, test } from "vitest";

import { cloudGateway, creditsFit, creditsGatewayFor, HOSTED_CLOUD, onCavemanHost, serviceOrigin } from "./hosted.ts";

const OWN = "https://app.customer.example";

test("the hosted Cloud keeps Caveman's gateway; another Cloud only the one its grant named", () => {
  expect(cloudGateway({ cloud_url: HOSTED_CLOUD })).toBe(CREDITS_GATEWAY_URL);
  expect(cloudGateway({ cloud_url: HOSTED_CLOUD, gateway_url: "https://gateway.elsewhere.example" })).toBe(CREDITS_GATEWAY_URL);
  expect(cloudGateway({ cloud_url: OWN, gateway_url: "https://gateway.customer.example" })).toBe("https://gateway.customer.example");
  expect(cloudGateway({ cloud_url: OWN })).toBeUndefined();
  // A credits key keeps no gateway for the hosted Cloud (stored as before) and its own Cloud's otherwise.
  expect(creditsGatewayFor({ cloud_url: HOSTED_CLOUD })).toBeUndefined();
  expect(creditsGatewayFor({ cloud_url: OWN, gateway_url: "https://gateway.customer.example" })).toBe("https://gateway.customer.example");
});

test("a held credits key fits only the Cloud that would mint it", () => {
  const own = { cloud_url: OWN, gateway_url: "https://gateway.customer.example" };
  expect(creditsFit({}, { cloud_url: HOSTED_CLOUD })).toBe(true);
  expect(creditsFit({ gateway: "https://gateway.customer.example" }, own)).toBe(true);
  // The hosted Cloud's key on a company's Cloud, and the reverse.
  expect(creditsFit({}, own)).toBe(false);
  expect(creditsFit({ gateway: "https://gateway.customer.example" }, { cloud_url: HOSTED_CLOUD })).toBe(false);
  expect(creditsFit({ gateway: "https://gateway.other.example" }, own)).toBe(false);
});

test("a Cloud's gateway is an http(s) origin, and a Caveman host only for Caveman's own Cloud", () => {
  expect(serviceOrigin(OWN, "https://gateway.customer.example")).toBe("https://gateway.customer.example");
  expect(serviceOrigin(OWN, "https://gateway.customer.example/")).toBe("https://gateway.customer.example");
  expect(serviceOrigin("http://127.0.0.1:3000", "http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  for (const bad of [undefined, "", 42, "ftp://gateway.customer.example", "https://user:pw@gateway.customer.example", "https://gateway.customer.example/v1", "https://gateway.customer.example?x=1", "not a url"]) {
    expect(serviceOrigin(OWN, bad)).toBeUndefined();
  }
  // A company install that left its gateway pointed at ours: not taken.
  expect(serviceOrigin(OWN, "https://gateway.caveman.so")).toBeUndefined();
  expect(serviceOrigin(OWN, "https://caveman.so")).toBeUndefined();
  expect(serviceOrigin(HOSTED_CLOUD, "https://gateway.caveman.so")).toBe("https://gateway.caveman.so");
  expect([onCavemanHost("https://api.caveman.so/x"), onCavemanHost("https://caveman.so"), onCavemanHost("https://notcaveman.so"), onCavemanHost("https://caveman.so.example")]).toEqual([true, true, false, false]);
});
