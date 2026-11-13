import styles from "./inbox.module.css";

/** Two-pane placeholder that matches the inbox layout so streaming in causes no shift. */
export function InboxSkeleton() {
  return <main className={`${styles.inbox} cg-skeleton`} aria-busy="true">
    <span className="sr-only" role="status">Loading inbox</span>
    <section className={styles.listPane} aria-hidden="true">
      <div className={styles.listHead}><i className="skeleton" style={{ width: 90, height: 24 }} /><i className="skeleton" style={{ width: 220, height: 28 }} /></div>
      <div className={styles.list}>{Array.from({ length: 6 }, (_, index) => <div key={index} className={styles.item}><i className="skeleton" style={{ width: 32, height: 32, borderRadius: "50%" }} /><span style={{ display: "grid", gap: 6 }}><i className="skeleton" style={{ width: "60%", height: 12 }} /><i className="skeleton" style={{ width: "85%", height: 12 }} /></span></div>)}</div>
    </section>
    <section className={styles.reader} aria-hidden="true" />
  </main>;
}
