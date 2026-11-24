import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { chief, PROJECT, runtimeFixture, workspace } from "../../test/fixtures.ts";

const profile = chief("c-app", "app", { project_id: PROJECT.id, project_default: true });
const fixture = () =>
  runtimeFixture({ chiefs: [profile], workspaces: [workspace("c-app", { kind: "chief" })] });
const box = () => page.getByRole("combobox", { name: "Message" });
const clear = async () => {
  await userEvent.click(box());
  await userEvent.keyboard("/clear{Enter}");
};

test("loading: /clear never reaches chief.capture while chief.get is delayed", async () => {
  const app = await mountApp(
    "/chief/c-app",
    fixture(),
    {},
    {
      setup: (peer) => {
        peer.on("chief.get", () => new Promise(() => {}));
        peer.hold("chief.capture");
      },
    },
  );
  try {
    await clear();
    await expect
      .element(page.getByText("Wait for the Chief to load before clearing.").last(), {
        timeout: 2000,
      })
      .toBeVisible();
    expect(app.peer.callsOf("chief.capture")).toHaveLength(0);
    await expect.element(box()).toHaveValue("/clear");
  } finally {
    await app.unmount();
  }
});
