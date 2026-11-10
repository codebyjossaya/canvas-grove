import "server-only";
import type { EncryptedBrowserState, HostedBrowserProvider, HostedSessionState } from "../hosted-browser";

export class DevelopmentOnlyHostedBrowserProvider implements HostedBrowserProvider {
  private fail(): never { throw new Error("DEVELOPMENT-ONLY hosted browser provider: configure Browserbase before using Canvas sessions"); }
  async provision(): Promise<{ providerSessionId: string }> { return this.fail(); }
  async interactiveConnect(): Promise<{ url: string; expiresAt: number }> { return this.fail(); }
  async status(): Promise<{ state: Exclude<HostedSessionState, "terminated">; canvasAccountId?: string; authRequired?: boolean }> { return this.fail(); }
  async navigate(): Promise<void> { return this.fail(); }
  async relinquishInteractive(): Promise<{ providerSessionId: string }> { return this.fail(); }
  async snapshotEncrypted(): Promise<EncryptedBrowserState> { return this.fail(); }
  async terminate(): Promise<void> { return this.fail(); }
}
