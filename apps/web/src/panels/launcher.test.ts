import { expect, test } from "vitest";
import { asUrl } from "./launcher.tsx";

test("asUrl: addresses become URLs, file names stay files in the launcher", () => {
  expect(asUrl("localhost:3000/x")).toBe("http://localhost:3000/x");
  expect(asUrl("app.localhost:3000")).toBe("http://app.localhost:3000");
  expect(asUrl(":5173")).toBe("http://localhost:5173");
  expect(asUrl("192.168.1.5:8080")).toBe("http://192.168.1.5:8080");
  expect(asUrl("bbc.co.uk")).toBe("https://bbc.co.uk");
  expect(asUrl("https://a.b/c")).toBe("https://a.b/c");
  for (const file of ["main.go", "README.md", "build.sh", "lib.so", "a b.com", "foo.test"]) expect(asUrl(file)).toBeNull();
  expect(asUrl("foo.test", true)).toBe("https://foo.test");
  expect(asUrl("javascript:alert(1)", true)).toBeNull();
});
