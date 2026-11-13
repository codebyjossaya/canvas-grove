import { AppLink } from "@/components/ui/app-link";
import { Icon } from "@/components/ui/icons";
import { dateTime, relativePast } from "@/lib/views/dates";
import type { InboxAnnouncement, InboxView } from "@/lib/views/types";
import { ListKeys } from "./list-keys";
import styles from "./inbox.module.css";

export function InboxScreen({ view, now }: { view: InboxView; now: string }) {
  const { zone } = view;
  const unread = view.threads.filter(thread => thread.unread).length;
  const selected = view.tab === "messages" ? view.selectedThread : view.selectedAnnouncement;
  const hrefs = view.tab === "messages" ? view.threads.map(thread => `/inbox?c=${thread.id}`) : view.announcements.map(item => `/inbox?tab=announcements&a=${item.id}`);
  const current = view.tab === "messages" ? view.selectedThread?.id : view.selectedAnnouncement?.id;
  return <main className={`${styles.inbox} ${selected ? styles.reading : ""}`}>
    <section className={styles.listPane} aria-label={view.tab === "messages" ? "Conversations" : "Announcements"}>
      <header className={styles.listHead}>
        <h1>Inbox</h1>
        <nav className={styles.tabs} aria-label="Inbox sections">
          <AppLink href="/inbox" aria-current={view.tab === "messages" ? "page" : undefined}>Messages{unread > 0 && <span className="count">{unread}</span>}</AppLink>
          <AppLink href="/inbox?tab=announcements" aria-current={view.tab === "announcements" ? "page" : undefined}>Announcements<span className="count">{view.announcements.length}</span></AppLink>
        </nav>
      </header>
      <ListKeys hrefs={hrefs} current={current ? hrefs[(view.tab === "messages" ? view.threads.map(thread => thread.id) : view.announcements.map(item => item.id)).indexOf(current)] : null} />
      {view.tab === "messages" ? (view.threads.length ? <ul className={styles.list}>{view.threads.map(thread => <li key={thread.id}>
        <AppLink href={`/inbox?c=${thread.id}`} className={`${styles.item} ${thread.unread ? styles.unread : ""}`} aria-current={view.selectedThread?.id === thread.id ? "true" : undefined}>
          <span className={styles.avatar} aria-hidden="true">{thread.initials}</span>
          <span className={styles.itemMain}>
            <span className={styles.itemTop}><strong>{thread.participants}</strong><time dateTime={thread.lastAt ?? undefined}>{relativePast(thread.lastAt, now, zone)}</time></span>
            <span className={styles.subject}>{thread.unread && <i className={styles.dot} aria-label="Unread" />}{thread.subject}{thread.count > 1 && <span className={styles.msgCount}>{thread.count}</span>}</span>
            {thread.preview && <span className={styles.preview}>{thread.preview}</span>}
            {thread.course && <span className={`course-code c${thread.course.color}`}>{thread.course.code}</span>}
          </span>
        </AppLink>
      </li>)}</ul> : <div className="empty-state"><span className="empty-icon"><Icon name="mail" /></span><h2>No conversations</h2><p>Canvas Grove syncs unread Canvas conversations. When something new arrives it shows up here.</p></div>)
        : (view.announcements.length ? <ul className={styles.list}>{view.announcements.map(item => <li key={item.id}>
          <AppLink href={`/inbox?tab=announcements&a=${item.id}`} className={styles.item} aria-current={view.selectedAnnouncement?.id === item.id ? "true" : undefined}>
            <span className={`${styles.avatar} ${styles.news} ${item.course ? `c${item.course.color}` : ""}`} aria-hidden="true"><Icon name="megaphone" /></span>
            <span className={styles.itemMain}>
              <span className={styles.itemTop}><strong>{item.title}</strong><time dateTime={item.at ?? undefined}>{relativePast(item.at, now, zone)}</time></span>
              {item.preview && <span className={styles.preview}>{item.preview}</span>}
              {item.course && <span className={`course-code c${item.course.color}`}>{item.course.code}</span>}
            </span>
          </AppLink>
        </li>)}</ul> : <div className="empty-state"><span className="empty-icon"><Icon name="megaphone" /></span><h2>No announcements yet</h2><p>New course announcements appear here after the next sync.</p></div>)}
    </section>

    <section className={styles.reader} aria-label="Reader">
      {view.tab === "messages" && view.selectedThread ? <article className={styles.article}>
        <AppLink className={styles.back} href="/inbox"><Icon name="arrow-left" />Inbox</AppLink>
        <header className={styles.articleHead}>
          <h2>{view.selectedThread.subject}</h2>
          <p>{view.selectedThread.course && <span className={`course-code c${view.selectedThread.course.color}`}>{view.selectedThread.course.code}</span>}<span>{view.selectedThread.participants}</span></p>
        </header>
        <ol className={styles.messages}>{view.selectedThread.messages.map(message => <li key={message.id}>
          <div className={styles.messageHead}><span className={styles.avatar} aria-hidden="true">{message.initials}</span><strong>{message.author}</strong><time dateTime={message.at ?? undefined}>{dateTime(message.at, zone)}</time></div>
          <div className={styles.body}>{message.paragraphs.length ? message.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>) : <p className={styles.muted}>No message text was synced.</p>}</div>
          {message.attachments.length > 0 && <ul className={styles.attachments}>{message.attachments.map(file => <li key={file.name}>{file.url ? <a href={file.url} target="_blank" rel="noopener noreferrer"><Icon name="file" />{file.name}</a> : <span><Icon name="file" />{file.name}</span>}</li>)}</ul>}
        </li>)}
        {!view.selectedThread.messages.length && <li className={styles.muted}>Message bodies for this conversation have not synced yet.</li>}</ol>
        {view.canvasInboxUrl && <footer className={styles.articleFoot}><a className="button secondary" href={view.canvasInboxUrl} target="_blank" rel="noopener noreferrer">Reply in Canvas <Icon name="external" /></a></footer>}
      </article>
        : view.tab === "announcements" && view.selectedAnnouncement ? <AnnouncementReader item={view.selectedAnnouncement} zone={zone} />
          : <div className={`empty-state ${styles.placeholder}`}><span className="empty-icon"><Icon name={view.tab === "messages" ? "mail" : "megaphone"} /></span><h2>Nothing selected</h2><p>Choose {view.tab === "messages" ? "a conversation" : "an announcement"} to read it here. Use <kbd className="kbd">J</kbd> and <kbd className="kbd">K</kbd> to move through the list.</p></div>}
    </section>
  </main>;
}

function AnnouncementReader({ item, zone }: { item: InboxAnnouncement; zone: string }) {
  return <article className={styles.article}>
    <AppLink className={styles.back} href="/inbox?tab=announcements"><Icon name="arrow-left" />Announcements</AppLink>
    <header className={styles.articleHead}>
      <h2>{item.title}</h2>
      <p>{item.course && <span className={`course-code c${item.course.color}`}>{item.course.code}</span>}<time dateTime={item.at ?? undefined}>{dateTime(item.at, zone)}</time></p>
    </header>
    <div className={styles.body}>{item.paragraphs.length ? item.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>) : <p className={styles.muted}>This announcement has no text body.</p>}</div>
    {item.canvasUrl && <footer className={styles.articleFoot}><a className="button secondary" href={item.canvasUrl} target="_blank" rel="noopener noreferrer">Open in Canvas <Icon name="external" /></a></footer>}
  </article>;
}
