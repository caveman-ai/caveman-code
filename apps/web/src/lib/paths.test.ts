import { expect, test } from "vitest";
import { baseName, isTypedPath, parentPath, pathKey, tildify } from "./paths.ts";

test("a typed path is a POSIX, home, drive or UNC path", () => {
  for (const raw of ["/Users/me/app", "~", "~/code", "C:\\src\\app", "c:/src/app", "\\\\server\\share\\app"]) expect(isTypedPath(raw)).toBe(true);
  for (const raw of ["app", "acme/widgets", "C:", "https://github.com/a/b", "github.com/a/b"]) expect(isTypedPath(raw)).toBe(false);
});

test("the home folder reads ~ on macOS, Linux and Windows", () => {
  expect(tildify("/Users/me/code/app")).toBe("~/code/app");
  expect(tildify("/home/me")).toBe("~");
  expect(tildify("C:\\Users\\me\\code\\app")).toBe("~\\code\\app");
  expect(tildify("c:/users/me/code")).toBe("~/code");
  expect(tildify("D:\\work\\app")).toBe("D:\\work\\app");
  expect(tildify("/Users/me", false)).toBe("/Users/me");
  expect(tildify("C:\\Users\\me", false)).toBe("C:\\Users\\me");
  expect(tildify("C:\\Users\\me\\x", false)).toBe("~\\x");
});

test("names and parents in either separator", () => {
  expect(baseName("/Users/me/app/")).toBe("app");
  expect(baseName("C:\\src\\app")).toBe("app");
  expect(parentPath("/Users/me/app")).toBe("/Users/me");
  expect(parentPath("/app")).toBe("/");
  expect(parentPath("C:\\src\\app")).toBe("C:\\src");
  expect(parentPath("C:\\app")).toBe("C:\\");
  expect(pathKey("C:\\Src\\App")).toBe(pathKey("c:/src/app"));
});
