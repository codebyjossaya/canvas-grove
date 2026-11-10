import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/app-shell";
import { CanvasSessionManager } from "@/components/ui/canvas-session";
import { BackgroundSyncStatus } from "@/components/ui/sync-status";
import { OnboardingGate } from "@/components/ui/onboarding-gate";
import { ThemeControl } from "@/components/ui/theme-provider";
import { TimeZoneSettings } from "@/components/ui/timezone-settings";

export default function SettingsPage() { return <Suspense fallback={<PageSkeleton label="Loading settings"/>}><OnboardingGate><ProtectedSettings/></OnboardingGate></Suspense>; }
async function ProtectedSettings() { const session=await auth(); if(!session.userId) redirect("/sign-in"); return <main className="dashboard route-page"><header className="dashboard-head"><div><p className="eyebrow">Settings</p><h1>Connection, sync &amp; privacy.</h1><p>Control how Canvas Grove accesses, refreshes, and retains your data.</p></div><Link className="button secondary" href="/welcome?replay=1">Replay orientation</Link></header><section className="panel appearance-panel" aria-labelledby="appearance-heading"><div><p className="eyebrow">Display</p><h2 id="appearance-heading">Appearance</h2><p>Switch between light and dark, or return to this device&apos;s setting.</p></div><ThemeControl allowSystemReset/></section><TimeZoneSettings/><BackgroundSyncStatus/><CanvasSessionManager/></main>; }
