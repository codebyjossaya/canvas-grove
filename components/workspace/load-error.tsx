import { Icon } from "@/components/ui/icons";
import { RetryButton } from "./retry-button";

/** Server-rendered failure state: saved data is untouched, and retry re-runs the loader. */
export function LoadError({ what }: { what: string }) {
  return <main className="page"><section className="empty-state error" role="alert">
    <span className="empty-icon"><Icon name="alert" /></span>
    <h2>We couldn’t load {what}</h2>
    <p>Your synced Canvas data is safe and nothing was changed. This is usually temporary.</p>
    <div className="actions"><RetryButton /></div>
  </section></main>;
}
