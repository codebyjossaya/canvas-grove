import "server-only";
import type { HostedBrowserProvider } from "../hosted-browser";
import { BrowserbaseHostedBrowserProvider } from "./browserbase";
import { DevelopmentOnlyHostedBrowserProvider } from "./dev";
import { SelfHostedChromiumProvider } from "./self-hosted";

export function createHostedBrowserProvider(): HostedBrowserProvider {
  const selected = process.env.HOSTED_BROWSER_PROVIDER || "self-hosted";
  if (selected === "self-hosted") return new SelfHostedChromiumProvider();
  if (selected === "browserbase") return new BrowserbaseHostedBrowserProvider();
  if (selected === "dev" && process.env.NODE_ENV !== "production") return new DevelopmentOnlyHostedBrowserProvider();
  throw new Error(`Unsupported or unsafe HOSTED_BROWSER_PROVIDER: ${selected}`);
}
