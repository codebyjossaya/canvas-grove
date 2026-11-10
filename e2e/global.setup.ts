import { clerkSetup } from "@clerk/testing/playwright";
import { expect, test as setup } from "@playwright/test";

setup("configure Clerk testing token", async () => {
  expect(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY).toMatch(/^pk_test_/);
  await clerkSetup();
});
