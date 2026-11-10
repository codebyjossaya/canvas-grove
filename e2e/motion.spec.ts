import { expect, test } from "@playwright/test";

test.describe("calm motion system", () => {
  test("landing motion completes without looping or layout shift", async ({ page }) => {
    await page.addInitScript(() => {
      let score = 0;
      new PerformanceObserver(list => {
        for (const entry of list.getEntries() as Array<PerformanceEntry & { hadRecentInput?: boolean; value?: number }>) {
          if (!entry.hadRecentInput) score += entry.value ?? 0;
        }
        (window as typeof window & { __motionCls?: number }).__motionCls = score;
      }).observe({ type: "layout-shift", buffered: true });
    });

    await page.goto("/");
    await expect(page.getByText("Everything in Canvas.")).toBeVisible();
    await page.waitForTimeout(600);

    const result = await page.evaluate(() => ({
      cls: (window as typeof window & { __motionCls?: number }).__motionCls ?? 0,
      runningAnimations: document.getAnimations().filter(animation => animation.playState === "running").length,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(result.cls).toBeLessThan(0.01);
    expect(result.runningAnimations).toBe(0);
    expect(result.horizontalOverflow).toBeLessThanOrEqual(1);
  });

  test("only live work animates and reduced motion makes every state still", async ({ page }) => {
    await page.goto("/");
    const normal = await page.evaluate(() => {
      const fixture = document.createElement("div");
      fixture.innerHTML = `
        <span class="sync-compact running"><i></i>Syncing</span>
        <span class="sync-compact fresh"><i></i>Fresh</span>
        <span class="viewer-spinner"></span>`;
      document.body.append(fixture);
      const [running, fresh, viewer] = fixture.querySelectorAll("i, i, .viewer-spinner");
      const viewerFill = getComputedStyle(viewer, "::after");
      return {
        running: getComputedStyle(running).animationName,
        fresh: getComputedStyle(fresh).animationName,
        viewer: viewerFill.animationName,
      };
    });
    expect(normal.running).toBe("sync-breathe");
    expect(normal.fresh).toBe("none");
    expect(normal.viewer).toBe("grove-progress");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    const reduced = await page.evaluate(() => {
      const fixture = document.createElement("div");
      fixture.innerHTML = `<span class="sync-compact running"><i></i>Syncing</span><span class="viewer-spinner"></span>`;
      document.body.append(fixture);
      const dot = fixture.querySelector("i")!;
      const viewer = fixture.querySelector(".viewer-spinner")!;
      return {
        dotIterations: getComputedStyle(dot).animationIterationCount,
        dotDuration: getComputedStyle(dot).animationDuration,
        viewerIterations: getComputedStyle(viewer, "::after").animationIterationCount,
        viewerDuration: getComputedStyle(viewer, "::after").animationDuration,
      };
    });
    expect(reduced.dotIterations).toBe("1");
    expect(reduced.viewerIterations).toBe("1");
    expect(parseFloat(reduced.dotDuration)).toBeLessThanOrEqual(0.001);
    expect(parseFloat(reduced.viewerDuration)).toBeLessThanOrEqual(0.001);
  });

  test("keyboard focus remains visible and mobile does not overflow", async ({ page }) => {
    await page.goto("/");
    const signIn = page.getByRole("button", { name: "Sign in" }).first();
    await expect(signIn).toBeVisible();
    await signIn.focus();
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      return element instanceof HTMLElement ? getComputedStyle(element).outlineStyle : "none";
    });
    expect(focus).not.toBe("none");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
