"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppLink } from "@/components/ui/app-link";
import { EXTENSION_DOWNLOAD_URL } from "@/lib/extension/links";
import styles from "./extension.module.css";

export type ExtensionDeviceFixture = { id: string; name: string; pairedAt: string | null; lastSeenAt: string | null };
const headers = { "x-grove-csrf": "1" };

function ago(iso: string | null) {
  if (!iso) return "never used";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 2) return "used just now";
  if (minutes < 60) return `used ${minutes} min ago`;
  if (minutes < 60 * 24) return `used ${Math.round(minutes / 60)} h ago`;
  return `used ${Math.round(minutes / 1440)} d ago`;
}

export function ExtensionDevices({ fixture }: { fixture?: ExtensionDeviceFixture[] }) {
  const [devices, setDevices] = useState<ExtensionDeviceFixture[] | null>(fixture ?? null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const cancel = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    if (fixture) { setDevices(fixture); setError(""); return; }
    try {
      const response = await fetch("/api/canvas/extension/devices", { headers, cache: "no-store" });
      if (!response.ok) throw new Error();
      setDevices((await response.json()).devices);
      setError("");
    } catch { setError("Could not load connected browsers."); }
  }, [fixture]);

  useEffect(() => {
    if (fixture) return;
    let live = true;
    fetch("/api/canvas/extension/devices", { headers, cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("load"))))
      .then((body) => { if (live) setDevices(body.devices); })
      .catch(() => { if (live) setError("Could not load connected browsers."); });
    return () => { live = false; };
  }, [fixture]);
  useEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);

  async function disconnect(id: string) {
    if (busy) return;
    const current = devices ?? [];
    const index = current.findIndex((device) => device.id === id);
    const nextId = current[index + 1]?.id ?? current[index - 1]?.id;
    setBusy(id);
    setDevices((current) => current?.filter((d) => d.id !== id) ?? null);
    if (!fixture) {
      const response = await fetch(`/api/canvas/extension/devices/${id}`, { method: "DELETE", headers });
      if (!response.ok) { setError("Could not disconnect that browser."); void load(); }
    }
    setConfirming(null);
    setBusy(null);
    window.requestAnimationFrame(() => (nextId ? triggers.current[nextId] : heading.current)?.focus());
  }

  function cancelDisconnect(id: string) {
    setConfirming(null);
    window.requestAnimationFrame(() => triggers.current[id]?.focus());
  }

  return <section id="extension" className="panel" aria-labelledby="extension-heading">
    <div className={styles.head}>
      <div><h2 id="extension-heading" ref={heading} tabIndex={-1}>Browser extension</h2><p>Required for Canvas sign-in. It keeps institution authentication in your own browser and connects only the Canvas session you explicitly confirm.</p></div>
      <div className={styles.headActions} aria-label="Browser extension actions"><AppLink className="button primary" href="/extension/connect">Connect a browser</AppLink><a className="button secondary" href={EXTENSION_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">Get the extension</a></div>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {devices === null && !error ? <p className={styles.empty}>Loading…</p> : null}
    {devices?.length === 0 ? <p className={styles.empty}>No browsers connected yet.</p> : null}
    {devices?.length ? <ul className={styles.list}>{devices.map((device) => <li key={device.id} className={styles.device}>
      <div><div className={styles.deviceName}>{device.name}</div><div className={styles.deviceMeta}>{ago(device.lastSeenAt)}</div></div>
      {confirming === device.id ? <div className="page-actions" role="group" aria-label={`Confirm disconnect ${device.name}`}>
        <button type="button" className="danger-button" disabled={busy === device.id} aria-busy={busy === device.id} onClick={() => void disconnect(device.id)}>Confirm disconnect</button>
        <button ref={cancel} type="button" className="button ghost" disabled={busy === device.id} onClick={() => cancelDisconnect(device.id)}>Keep browser</button>
      </div> : <button ref={node => { triggers.current[device.id] = node; }} type="button" className="danger-button" onClick={() => setConfirming(device.id)} aria-label={`Disconnect ${device.name}`}>Disconnect</button>}
    </li>)}</ul> : null}
  </section>;
}
