import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { SECURE_BROWSER_WINDOW_NAME, secureBrowserPopupFeatures } from "../lib/popup-window";

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://fixture").pathname;
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/secure-browser") {
      response.end(`<!doctype html><button id="complete">Complete sign-in</button><script>opener.postMessage({source:"canvas-grove-popup",type:"shell-ready"},location.origin);document.querySelector('#complete').onclick=()=>{opener.postMessage({source:"canvas-grove-popup",type:"completed"},location.origin);close()}</script>`);
      return;
    }
    response.end(`<!doctype html><button id="open">Open secure browser</button><button id="focus">Focus secure browser</button><output id="status">idle</output><script>let popup;const output=document.querySelector('#status');const features=${JSON.stringify(secureBrowserPopupFeatures({ availWidth: 1440, availHeight: 900 }))};document.querySelector('#open').onclick=()=>{popup=window.open('/secure-browser',${JSON.stringify(SECURE_BROWSER_WINDOW_NAME)},features);output.textContent=popup?'open':'blocked'};document.querySelector('#focus').onclick=()=>{if(popup&&!popup.closed){popup.focus();output.textContent='focused'}else{output.textContent='closed'}};addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==popup||event.data?.source!=='canvas-grove-popup')return;output.textContent=event.data.type})</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("popup fixture failed to listen");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

test("direct gesture opens, focuses, completes, and reopens one named window", async ({ page, context }) => {
  await page.goto(origin);
  const firstPopupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open secure browser" }).click();
  const firstPopup = await firstPopupPromise;
  await expect(firstPopup).toHaveURL(`${origin}/secure-browser`);
  await expect(page.locator("#status")).toHaveText("shell-ready");

  await page.getByRole("button", { name: "Focus secure browser" }).click();
  await expect(page.locator("#status")).toHaveText("focused");
  expect(context.pages()).toHaveLength(2);

  await firstPopup.getByRole("button", { name: "Complete sign-in" }).click();
  await expect(page.locator("#status")).toHaveText("completed");
  await expect.poll(() => firstPopup.isClosed()).toBe(true);

  const reopenedPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open secure browser" }).click();
  const reopened = await reopenedPromise;
  await expect(reopened).toHaveURL(`${origin}/secure-browser`);
  expect(context.pages()).toHaveLength(2);
});
