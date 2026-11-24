import { expect, test } from "@playwright/test";

test("resumes a past conversation with its remembered suffix, excluding it once open", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Start session on writer", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const rows = dialog.locator(".past-session");
  await expect(rows.nth(0)).toContainText("Recent conversation");
  await expect(rows.nth(1)).toContainText("Older conversation");
  await expect(rows.nth(0)).toHaveAttribute("title", "past-new");
  await rows.nth(0).click();
  await expect(dialog.getByLabel("Path", { exact: true })).toHaveValue(
    "/work/project",
  );
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
    "review",
  );
  await dialog
    .getByRole("button", { name: "Resume session", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "project.review", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Start session on writer", exact: true })
    .click();
  await expect(
    page.locator('.past-session[data-session-id="past-new"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('.past-session[data-session-id="past-old"]'),
  ).toBeVisible();
});

test("shift-selects and resumes past sessions with their own paths and names", async ({
  page,
}) => {
  const launches: { cwd: string; name: string; sessionId: string }[] = [];
  await page.route("**/api/hosts/writer/sessions", async (route) => {
    if (route.request().method() === "POST")
      launches.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.goto("/");
  const start = page.getByRole("button", {
    name: "Start session on writer",
    exact: true,
  });
  await start.click();
  const dialog = page.getByRole("dialog");
  const recent = dialog.locator('.past-session[data-session-id="past-new"]');
  const older = dialog.locator('.past-session[data-session-id="past-old"]');
  await recent.click();
  await older.click({ modifiers: ["Shift"] });
  await expect(recent).toHaveAttribute("aria-pressed", "true");
  await expect(older).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: /resume .*sessions/i }).click();
  await expect(dialog).not.toBeVisible();
  expect(launches).toHaveLength(2);
  expect(launches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sessionId: "past-new",
        cwd: "/work/project",
        name: "review",
      }),
      expect.objectContaining({
        sessionId: "past-old",
        cwd: "/work/other",
        name: "",
      }),
    ]),
  );
  await expect(
    page.getByRole("button", { name: "project.review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "other", exact: true }),
  ).toBeVisible();
  await start.click();
  await expect(dialog.locator(".past-session")).toHaveCount(0);
});

test("resumes sessions with the same path and name under distinct labels", async ({
  page,
}) => {
  const launches: {
    sessionId: string;
    cwd: string;
    name: string;
    reservedLabels?: string[];
  }[] = [];
  await page.route("**/api/hosts/writer/session-history", async (route) => {
    await route.fulfill({
      json: {
        sessions: [
          {
            sessionId: "past-new",
            cwd: "/work/project",
            title: "Recent conversation",
            modifiedAt: 1_800_000_000_000,
            name: "review",
          },
          {
            sessionId: "past-copy",
            cwd: "/work/project",
            title: "Recent conversation",
            modifiedAt: 1_700_000_000_000,
            name: "review",
          },
        ],
      },
    });
  });
  await page.route("**/api/hosts/writer/sessions", async (route) => {
    if (route.request().method() === "POST")
      launches.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Start session on writer", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const recent = dialog.locator('.past-session[data-session-id="past-new"]');
  const copy = dialog.locator('.past-session[data-session-id="past-copy"]');
  await recent.click();
  await copy.click({ modifiers: ["Shift"] });
  await expect(recent).toHaveAttribute("aria-pressed", "true");
  await expect(copy).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: /resume .*sessions/i }).click();
  await expect(dialog).not.toBeVisible();
  expect(launches).toHaveLength(2);
  expect(launches[0]).toMatchObject({
    sessionId: "past-new",
    cwd: "/work/project",
    name: "review",
  });
  expect(launches[1]).toMatchObject({
    sessionId: "past-copy",
    cwd: "/work/project",
    name: "review",
    reservedLabels: ["project.review"],
  });
  await expect(
    page.getByRole("button", { name: "project.review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "project.review-2", exact: true }),
  ).toBeVisible();
});

test("retries a rate-limited batch launch before resuming the next session", async ({
  page,
}) => {
  const launches: { sessionId: string }[] = [];
  await page.route("**/api/hosts/writer/sessions", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      launches.push(body);
      if (launches.length === 1) {
        await route.fulfill({
          status: 429,
          headers: { "Retry-After": "1" },
          json: { error: "Rate limited" },
        });
        return;
      }
    }
    await route.continue();
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Start session on writer", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('.past-session[data-session-id="past-new"]').click();
  await dialog.locator('.past-session[data-session-id="past-old"]').click({
    modifiers: ["Shift"],
  });
  await dialog.getByRole("button", { name: "Resume 2 sessions" }).click();
  await expect(dialog).not.toBeVisible();
  expect(launches.map((launch) => launch.sessionId)).toEqual([
    "past-new",
    "past-new",
    "past-old",
  ]);
  await expect(
    page.getByRole("button", { name: "project.review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "other", exact: true }),
  ).toBeVisible();
});

for (const modifier of ["Control", "Meta"] as const) {
  test(`${modifier}-click toggles nonadjacent sessions and plain click selects one`, async ({
    page,
  }) => {
    const launches: { sessionId?: string; cwd: string; name: string }[] = [];
    await page.route("**/api/hosts/writer/session-history", async (route) => {
      await route.fulfill({
        json: {
          sessions: ["first", "second", "third"].map((id, index) => ({
            sessionId: id,
            cwd: `/work/${id}`,
            title: id,
            modifiedAt: 1_800_000_000_000 - index,
            name: id === "first" ? "saved" : "",
          })),
        },
      });
    });
    await page.route("**/api/hosts/writer/sessions", async (route) => {
      if (route.request().method() === "POST")
        launches.push(route.request().postDataJSON());
      await route.continue();
    });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Start session on writer", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    const first = dialog.locator('.past-session[data-session-id="first"]');
    const second = dialog.locator('.past-session[data-session-id="second"]');
    const third = dialog.locator('.past-session[data-session-id="third"]');

    await first.click();
    await third.click({ modifiers: [modifier] });
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(second).toHaveAttribute("aria-pressed", "false");
    await expect(third).toHaveAttribute("aria-pressed", "true");
    await expect(
      dialog.getByRole("button", { name: "Resume 2 sessions" }),
    ).toBeVisible();

    await third.click({ modifiers: [modifier] });
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(third).toHaveAttribute("aria-pressed", "false");
    await expect(
      dialog.getByRole("button", { name: "Resume session", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel("Path", { exact: true })).toHaveValue(
      "/work/first",
    );
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
      "saved",
    );

    await first.click({ modifiers: [modifier] });
    await expect(first).toHaveAttribute("aria-pressed", "false");
    await expect(
      dialog.getByRole("button", { name: "Start session", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("");
    await expect(dialog.getByLabel("Path", { exact: true })).toHaveValue(
      "/work/first",
    );
    await dialog
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    expect(launches).toEqual([{ cwd: "/work/first", name: "" }]);
    launches.length = 0;
    await page
      .getByRole("button", { name: "Start session on writer", exact: true })
      .click();

    await first.click();

    await third.click({ modifiers: [modifier] });
    await second.click();
    await expect(first).toHaveAttribute("aria-pressed", "false");
    await expect(second).toHaveAttribute("aria-pressed", "true");
    await expect(third).toHaveAttribute("aria-pressed", "false");

    await first.click();
    await third.click({ modifiers: [modifier] });
    await dialog.getByRole("button", { name: "Resume 2 sessions" }).click();
    await expect(dialog).not.toBeVisible();
    expect(launches.map((launch) => launch.sessionId)).toEqual([
      "first",
      "third",
    ]);
  });
}

test("shrinks a shift-selected range before resuming", async ({ page }) => {
  const launches: { sessionId: string }[] = [];
  await page.route("**/api/hosts/writer/session-history", async (route) => {
    await route.fulfill({
      json: {
        sessions: ["first", "second", "third"].map((id, index) => ({
          sessionId: id,
          cwd: `/work/${id}`,
          title: id,
          modifiedAt: 1_800_000_000_000 - index,
        })),
      },
    });
  });
  await page.route("**/api/hosts/writer/sessions", async (route) => {
    if (route.request().method() === "POST")
      launches.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Start session on writer", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const first = dialog.locator('.past-session[data-session-id="first"]');
  const second = dialog.locator('.past-session[data-session-id="second"]');
  const third = dialog.locator('.past-session[data-session-id="third"]');
  await first.click();
  await third.click({ modifiers: ["Shift"] });
  await expect(
    dialog.getByRole("button", { name: "Resume 3 sessions" }),
  ).toBeVisible();
  await second.click({ modifiers: ["Shift"] });
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(second).toHaveAttribute("aria-pressed", "true");
  await expect(third).toHaveAttribute("aria-pressed", "false");
  await dialog.getByRole("button", { name: "Resume 2 sessions" }).click();
  await expect(dialog).not.toBeVisible();
  expect(launches.map((launch) => launch.sessionId)).toEqual([
    "first",
    "second",
  ]);
});

test("retries only the failed session after a partial multi-resume", async ({
  page,
}) => {
  const launches: { cwd: string; name: string; sessionId: string }[] = [];
  let failOlder = true;
  await page.route("**/api/hosts/writer/sessions", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      launches.push(body);
      if (body.sessionId === "past-old" && failOlder) {
        failOlder = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Resume failed for older conversation",
          }),
        });
        return;
      }
    }
    await route.continue();
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Start session on writer", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('.past-session[data-session-id="past-new"]').click();
  await dialog.locator('.past-session[data-session-id="past-old"]').click({
    modifiers: ["Shift"],
  });
  await dialog.getByRole("button", { name: /resume .*sessions/i }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Resume failed for older conversation",
  );
  await expect(dialog.getByRole("status")).toContainText("past-old");
  await expect(
    dialog.locator('.past-session[data-session-id="past-new"]'),
  ).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.locator('.past-session[data-session-id="past-old"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog
    .getByRole("button", { name: "Resume session", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(
    launches.filter((launch) => launch.sessionId === "past-new"),
  ).toHaveLength(1);
  expect(launches.filter((launch) => launch.sessionId === "past-old")).toEqual([
    expect.objectContaining({
      cwd: "/work/other",
      name: "",
      sessionId: "past-old",
    }),
    expect.objectContaining({
      cwd: "/work/other",
      name: "",
      sessionId: "past-old",
    }),
  ]);
  await expect(
    page.getByRole("button", { name: "project.review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "other", exact: true }),
  ).toBeVisible();
});

for (const { name, retryName } of [
  { name: "review", retryName: "review" },
  { name: "", retryName: "" },
  { name: "review", retryName: "edited" },
]) {
  test(`keeps reserved labels when retrying one failed session (${name || "blank"} to ${retryName || "blank"})`, async ({
    page,
  }) => {
    const launches: {
      cwd: string;
      name: string;
      sessionId: string;
      reservedLabels?: string[];
    }[] = [];
    const ids = ["first", "second", "third"];
    const labels = [
      name ? `project.${name}` : "project",
      name ? `project.${name}-2` : "project.2",
      retryName === name
        ? name
          ? `project.${name}-3`
          : "project.3"
        : `project.${retryName}`,
    ];
    await page.route("**/api/hosts/writer/session-history", async (route) => {
      await route.fulfill({
        json: {
          sessions: ids.map((id, index) => ({
            sessionId: id,
            cwd: "/work/project",
            title: id,
            modifiedAt: 1_800_000_000_000 - index,
            name,
          })),
        },
      });
    });
    let failSecond = true;
    await page.route("**/api/hosts/writer/sessions", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        launches.push(body);
        if (body.sessionId === "second" && failSecond) {
          failSecond = false;
          await route.fulfill({
            status: 503,
            json: { error: "Temporary failure" },
          });
          return;
        }
      }
      await route.continue();
    });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Start session on writer", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('.past-session[data-session-id="first"]').click();
    await dialog.getByLabel("Name", { exact: true }).fill("stale");
    await dialog.locator('.past-session[data-session-id="third"]').click({
      modifiers: ["Shift"],
    });
    await dialog.getByRole("button", { name: "Resume 3 sessions" }).click();
    await expect(dialog.getByRole("status")).toContainText("Temporary failure");
    await expect(dialog.getByRole("status")).toContainText("second");
    await expect(dialog.locator(".past-session")).toHaveCount(1);
    await expect(
      dialog.locator('.past-session[data-session-id="second"]'),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(name);
    await dialog.getByLabel("Name", { exact: true }).fill(retryName);
    await dialog
      .getByRole("button", { name: "Resume session", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    expect(launches).toEqual([
      { sessionId: "first", cwd: "/work/project", name, reservedLabels: [] },
      {
        sessionId: "second",
        cwd: "/work/project",
        name,
        reservedLabels: [labels[0]],
      },
      {
        sessionId: "third",
        cwd: "/work/project",
        name,
        reservedLabels: [labels[0]],
      },
      {
        sessionId: "second",
        cwd: "/work/project",
        name: retryName,
        reservedLabels: [labels[0], labels[1]],
      },
    ]);
    for (const label of labels)
      await expect(
        page.getByRole("button", { name: label, exact: true }),
      ).toBeVisible();
  });
}

test("clears batch reservations when the last failed session is toggled off", async ({
  page,
}) => {
  const launches: Record<string, unknown>[] = [];
  await page.route("**/api/hosts/writer/session-history", async (route) => {
    await route.fulfill({
      json: {
        sessions: ["first", "second"].map((id, index) => ({
          sessionId: id,
          cwd: "/work/project",
          title: id,
          modifiedAt: 1_800_000_000_000 - index,
          name: "saved",
        })),
      },
    });
  });
  await page.route("**/api/hosts/writer/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON();
    launches.push(body);
    if (body.sessionId === "second") {
      await route.fulfill({
        status: 503,
        json: { error: "Temporary failure" },
      });
    } else {
      await route.fulfill({ json: { ok: true, label: "project.saved" } });
    }
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Start session on writer", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('.past-session[data-session-id="first"]').click();
  const second = dialog.locator('.past-session[data-session-id="second"]');
  await second.click({ modifiers: ["Control"] });
  await dialog.getByRole("button", { name: "Resume 2 sessions" }).click();
  await expect(dialog.getByRole("status")).toContainText("Temporary failure");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("saved");
  await second.click({ modifiers: ["Control"] });
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Path", { exact: true })).toHaveValue(
    "/work/project",
  );
  await dialog
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(launches).toEqual([
    {
      sessionId: "first",
      cwd: "/work/project",
      name: "saved",
      reservedLabels: [],
    },
    {
      sessionId: "second",
      cwd: "/work/project",
      name: "saved",
      reservedLabels: ["project.saved"],
    },
    { cwd: "/work/project", name: "" },
  ]);
});

test("forks the active session from its sidebar context menu", async ({
  page,
}) => {
  await page.request.post("http://127.0.0.1:4173/__activity?busy=1");
  await page.goto("/");
  const writerCard = page.locator('.session-card[title="Writable room"]');
  await expect(writerCard).toHaveAttribute("aria-description", "Working");
  await writerCard.click({ button: "right" });
  const forkButton = page.getByRole("button", {
    name: "Fork session",
    exact: true,
  });
  await expect(forkButton).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.request.post("http://127.0.0.1:4173/__activity?busy=0");
  await expect(writerCard).toHaveAttribute("aria-description", "Idle");
  await writerCard.click({ button: "right" });
  await expect(forkButton).toBeEnabled();
  const prompt = page
    .waitForEvent("dialog")
    .then((dialog) => dialog.accept("from-sidebar"));
  await forkButton.click();
  await prompt;
  await expect(
    page.getByRole("button", { name: "writer.from-sidebar", exact: true }),
  ).toBeVisible();
});

test("deselects history to start a new conversation and keeps launch collisions in the form", async ({
  page,
}) => {
  await page.goto("/");
  const start = page.getByRole("button", {
    name: "Start session on writer",
    exact: true,
  });
  await start.click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('.past-session[data-session-id="past-old"]').click();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("");
  await dialog
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await dialog.getByLabel("Name", { exact: true }).fill("fresh");
  await dialog
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "other.fresh", exact: true }),
  ).toBeVisible();
  await start.click();
  await dialog.getByLabel("Path", { exact: true }).fill("/work/other");
  await dialog.getByLabel("Name", { exact: true }).fill("fresh");
  await dialog
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("already exists");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("fresh");
  await expect(
    dialog.getByRole("button", { name: "Start session", exact: true }),
  ).toBeEnabled();
});

test("keeps the host launch button when its sessions belong to custom groups", async ({
  page,
  request,
}) => {
  await page.goto("/");
  // Agent activity loads after the groups, once the dashboard socket is up.
  await expect(
    page.locator('.session-card[title="Writable room"]'),
  ).toHaveAttribute("aria-description", "Working");
  await request.post("/api/groups", {
    data: { name: "Project", session: "writer:label:writer" },
  });
  await expect(
    page.getByRole("heading", { name: "Project", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Start session on writer", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("shows host access failures in the mobile popup", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("[data-session-drawer-toggle]").click();
  await page
    .getByRole("button", { name: "Start session on viewer", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "control-shared",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("browses, creates and selects host folders with path completion", async ({ page }) => {
  const created: string[] = [];
  await page.route("**/api/hosts/writer/folders**", async (route) => {
    if (route.request().method() === "POST") {
      created.push(route.request().postDataJSON().path);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const path = new URL(route.request().url()).searchParams.get("path");
    const directories: Record<string, string[]> = {
      "/work": ["project", "other"],
      "/work/project": [],
      "/work/project/new": [],
      "/home/writer": ["src"],
    };
    const resolved = path || "/home/writer";
    await route.fulfill({ json: { path: resolved, entries: directories[resolved] ?? [] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start session on writer" }).click();
  const dialog = page.getByRole("dialog");
  const path = dialog.getByLabel("Path", { exact: true });
  await path.fill("/work/pr");
  await expect(dialog.locator("#folder-path-suggestions option")).toHaveAttribute("value", "/work/project");
  await path.fill("/work");
  await dialog.getByRole("button", { name: "Browse folders" }).click();
  await dialog.getByRole("button", { name: "project", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Up", exact: true })).toBeFocused();
  await dialog.getByLabel("New folder name").fill("new");
  await dialog.getByRole("button", { name: "Create folder" }).click();
  await expect(dialog.locator(".folder-location")).toHaveText("/work/project/new");
  expect(created).toEqual(["/work/project/new"]);
  await dialog.getByRole("button", { name: "Select this folder" }).click();
  await expect(path).toHaveValue("/work/project/new");
  await dialog.getByRole("button", { name: "Browse folders" }).click();
  await dialog.getByRole("button", { name: "Home", exact: true }).click();
  await expect(dialog.locator(".folder-location")).toHaveText("/home/writer");
});

test("keeps the path editable when folder browsing fails", async ({ page }) => {
  await page.route("**/api/hosts/writer/folders**", async (route) => {
    await route.fulfill({ status: 501, json: { error: "Host does not support folder browsing" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start session on writer" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Browse folders" }).click();
  await expect(dialog.locator(".folder-status")).toHaveText("Host does not support folder browsing");
  await dialog.getByLabel("Path", { exact: true }).fill("/work/project");
  await expect(dialog.getByLabel("Path", { exact: true })).toHaveValue("/work/project");
});

test("ignores folder responses from an earlier navigation", async ({ page }) => {
  const { promise: pending, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: requested } = Promise.withResolvers<void>();
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
  await page.route("**/api/hosts/writer/folders**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path === "/slow") {
      requested();
      await pending;
      await route.fulfill({ json: { path: "/slow", entries: ["old"] } });
      finish();
    } else {
      await route.fulfill({ json: { path: "/home/writer", entries: ["current"] } });
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start session on writer" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Path", { exact: true }).fill("/slow");
  await dialog.getByRole("button", { name: "Browse folders" }).click();
  await started;
  await dialog.getByRole("button", { name: "Home", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "current", exact: true })).toBeVisible();
  release();
  await finished;
  await expect(dialog.locator(".folder-location")).toHaveText("/home/writer");
  await expect(dialog.getByRole("button", { name: "old", exact: true })).toHaveCount(0);
});

test("keeps failed locations unavailable for creation after a failed launch", async ({ page }) => {
  const created: string[] = [];
  await page.route("**/api/hosts/writer/folders**", async (route) => {
    if (route.request().method() === "POST") {
      created.push(route.request().postDataJSON().path);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path === "/work/missing") {
      await route.fulfill({ status: 404, json: { error: "Folder not found" } });
    } else {
      await route.fulfill({ json: { path: path || "/work", entries: ["missing"] } });
    }
  });
  await page.route("**/api/hosts/writer/sessions", async (route) => {
    await route.fulfill({ status: 409, json: { error: "Launch failed" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start session on writer" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Path", { exact: true }).fill("/work");
  await dialog.getByRole("button", { name: "Browse folders" }).click();
  const missing = dialog.getByRole("button", { name: "missing", exact: true });
  await missing.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.locator(".folder-status")).toHaveText("Folder not found");
  await expect(dialog.getByRole("button", { name: "Up", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(dialog.locator(".session-launch-status")).toHaveText("Launch failed");
  await expect(dialog.getByRole("button", { name: "Create folder" })).toBeDisabled();
  await dialog.getByLabel("New folder name").fill("new");
  await dialog.getByLabel("New folder name").press("Enter");
  expect(created).toEqual([]);
  await dialog.getByRole("button", { name: "Up", exact: true }).click();
  await expect(dialog.locator(".folder-location")).toHaveText("/work");
  await expect(dialog.getByRole("button", { name: "Create folder" })).toBeEnabled();
});

test("caches path completions until creation or launcher reset", async ({ page }) => {
  let listings = 0;
  let created = false;
  await page.route("**/api/hosts/writer/folders**", async (route) => {
    if (route.request().method() === "POST") {
      created = true;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const path = new URL(route.request().url()).searchParams.get("path") || "/work";
    if (path === "/work") listings++;
    await route.fulfill({ json: { path, entries: path === "/work" ? ["project", ...(created ? ["new"] : [])] : [] } });
  });
  await page.goto("/");
  const launch = page.getByRole("button", { name: "Start session on writer" });
  await launch.click();
  const dialog = page.getByRole("dialog");
  const path = dialog.getByLabel("Path", { exact: true });
  const options = dialog.locator("#folder-path-suggestions option");
  await path.fill("/work/p");
  await expect(options).toHaveAttribute("value", "/work/project");
  await path.fill("/work/pr");
  await expect(options).toHaveAttribute("value", "/work/project");
  expect(listings).toBe(1);
  await path.evaluate((input: HTMLInputElement) => { input.value = "/work"; });
  await dialog.getByRole("button", { name: "Browse folders" }).click();
  await expect(dialog.locator(".folder-location")).toHaveText("/work");
  await dialog.getByLabel("New folder name").fill("new");
  await dialog.getByRole("button", { name: "Create folder" }).click();
  await expect(dialog.locator(".folder-location")).toHaveText("/work/new");
  await path.fill("/work/n");
  await expect(options).toHaveAttribute("value", "/work/new");
  expect(listings).toBe(3);
  await page.keyboard.press("Escape");
  await launch.click();
  await path.fill("/work/p");
  await expect(options).toHaveAttribute("value", "/work/project");
  expect(listings).toBe(4);
});

test("does not cache an outdated completion response", async ({ page }) => {
  const { promise: pending, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: requested } = Promise.withResolvers<void>();
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
  await page.route("**/api/hosts/writer/folders**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path === "/slow") {
      requested();
      await pending;
      await route.fulfill({ json: { path, entries: ["stale"] } });
      finish();
    } else {
      await route.fulfill({ json: { path, entries: ["current"] } });
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start session on writer" }).click();
  const dialog = page.getByRole("dialog");
  const path = dialog.getByLabel("Path", { exact: true });
  const options = dialog.locator("#folder-path-suggestions option");
  await path.fill("/slow/s");
  await started;
  await path.fill("/fast/c");
  await expect(options).toHaveAttribute("value", "/fast/current");
  release();
  await finished;
  await path.fill("/fast/cu");
  await expect(options).toHaveAttribute("value", "/fast/current");
});

test("discards an in-flight completion when a folder is created", async ({ page }) => {
  const { promise: pending, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: requested } = Promise.withResolvers<void>();
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
  let delay = true;
  let created = false;
  await page.route("**/api/hosts/writer/folders**", async (route) => {
    if (route.request().method() === "POST") {
      created = true;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path === "/work" && delay) {
      delay = false;
      requested();
      await pending;
      await route.fulfill({ json: { path, entries: ["old"] } });
      finish();
      return;
    }
    await route.fulfill({ json: { path, entries: path === "/work" && created ? ["new"] : [] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start session on writer" }).click();
  const dialog = page.getByRole("dialog");
  const path = dialog.getByLabel("Path", { exact: true });
  const options = dialog.locator("#folder-path-suggestions option");
  await path.fill("/work/o");
  await started;
  await path.evaluate((input: HTMLInputElement) => { input.value = "/work"; });
  await dialog.getByRole("button", { name: "Browse folders" }).click();
  await expect(dialog.locator(".folder-location")).toHaveText("/work");
  await dialog.getByLabel("New folder name").fill("new");
  await dialog.getByRole("button", { name: "Create folder" }).click();
  await expect(dialog.locator(".folder-location")).toHaveText("/work/new");
  release();
  await finished;
  await path.fill("/work/n");
  await expect(options).toHaveAttribute("value", "/work/new");
});
