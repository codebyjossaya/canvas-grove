import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { EmptySyncState, PageSkeleton } from "@/components/ui/app-shell";
import { OnboardingGate } from "@/components/ui/onboarding-gate";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { tenantRepository } from "@/lib/db/repository";

export default function InboxPage() { return <Suspense fallback={<PageSkeleton label="Loading inbox"/>}><OnboardingGate><ProtectedInbox/></OnboardingGate></Suspense>; }
async function ProtectedInbox() {
  const session = await auth(); if (!session.userId) redirect("/sign-in");
  const repo = tenantRepository(await ensureUserForClerk(session.userId));
  const [conversations, announcements] = await Promise.all([repo.listConversations(), repo.listAnnouncements()]);
  return <main className="dashboard route-page"><header className="dashboard-head"><div><p className="eyebrow">Inbox</p><h1>Canvas conversations.</h1><p>Unread conversations and announcements, cached for quick access.</p></div></header>
    {conversations.length + announcements.length ? <div className="inbox-layout"><section className="panel"><div className="section-head"><div><p className="eyebrow">Messages</p><h2>Conversations</h2></div><span className="count-badge">{conversations.length}</span></div>{conversations.length ? <div className="message-list">{conversations.map((item) => <article key={item.id}><div className="message-avatar">{initials(item.participants)}</div><div><strong>{item.subject ?? "Canvas conversation"}</strong><small>{participants(item.participants)}{item.courseName ? ` · ${item.courseName}` : ""}</small></div><div className="message-meta"><time>{formatDate(item.lastMessageAt)}</time>{item.messageCount > 0 && <span>{item.messageCount}</span>}</div></article>)}</div> : <EmptySyncState icon="inbox" title="No unread conversations" body="Your Canvas inbox has no cached unread threads."/>}</section>
      <section className="panel"><div className="section-head"><div><p className="eyebrow">Course news</p><h2>Announcements</h2></div><span className="count-badge">{announcements.length}</span></div>{announcements.length ? <div className="announcement-list">{announcements.map((item) => <article key={item.id}><div><strong>{item.title}</strong><small>{item.courseName ?? "Canvas"} · {formatDate(item.postedAt)}</small></div>{item.bodyHtml && <p>{plainText(item.bodyHtml)}</p>}{safeCanvasUrl(item.htmlUrl) && <a href={item.htmlUrl!} target="_blank" rel="noreferrer">Open in Canvas</a>}</article>)}</div> : <EmptySyncState icon="inbox" title="No announcements cached" body="New Canvas announcements will appear here."/>}</section></div>
      : <EmptySyncState icon="inbox" title="No messages synced" body="Canvas returned no conversations or announcements yet." action={<Link className="button primary" href="/settings">Check sync</Link>}/>}</main>;
}
function participantRows(value: unknown) { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : []; }
function participants(value: unknown) { const names = participantRows(value).map((item) => typeof item.name === "string" ? item.name : "").filter(Boolean); return names.slice(0, 3).join(", ") || "Canvas"; }
function initials(value: unknown) { return participants(value).split(/[ ,]+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "C"; }
function formatDate(value: Date | null) { return value ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(value) : "Recently"; }
function plainText(value: string) { return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 220); }
function safeCanvasUrl(value: string | null) { try { return Boolean(value && new URL(value).protocol === "https:"); } catch { return false; } }
