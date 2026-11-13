import type { CSSProperties } from "react";
import type { AgentId } from "@/lib/connect-agent/catalog";
import styles from "./connect-agent.module.css";

// All real marks live in /public/agent-logos (see NOTICE.md there). Single-colour marks (fill=currentColor)
// are rendered through a CSS mask so they follow light/dark; colour marks are plain decorative images.
// To swap a logo, change its entry here.
const LOGOS: Record<Exclude<AgentId, "other">, { file: string; mono: boolean }> = {
  claude: { file: "claude", mono: false },
  chatgpt: { file: "openai", mono: true },
  "claude-code": { file: "claude-code", mono: false },
  codex: { file: "codex", mono: false },
  cursor: { file: "cursor", mono: true },
  vscode: { file: "github-copilot", mono: true },
  gemini: { file: "gemini-cli", mono: false },
};

/** Small original plug/link glyph for the generic "Other" card. */
function PlugGlyph() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0Z" /><path d="M12 16v5" /></svg>;
}

/** Decorative: the visible text always names the agent. */
export function AgentMark({ id }: { id: AgentId }) {
  if (id === "other") return <span className={styles.markBox}><PlugGlyph /></span>;
  const logo = LOGOS[id];
  const url = `/agent-logos/${logo.file}.svg`;
  if (!logo.mono) {
    // Decorative static SVG sized by CSS; next/image adds nothing here.
    // eslint-disable-next-line @next/next/no-img-element
    return <span className={styles.markBox}><img src={url} alt="" aria-hidden="true" width={24} height={24} draggable={false} /></span>;
  }
  const mask: CSSProperties = { WebkitMaskImage: `url(${url})`, maskImage: `url(${url})` };
  return <span className={styles.markBox}><span className={styles.mono} style={mask} /></span>;
}

/** Overlapping stack for the pill: Claude, ChatGPT, Cursor, GitHub Copilot. */
export const STACK: AgentId[] = ["claude", "chatgpt", "cursor", "vscode"];
