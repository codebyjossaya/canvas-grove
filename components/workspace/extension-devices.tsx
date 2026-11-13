"use client";

import { useCallback, useEffect, useState } from "react";
import { AppLink } from "@/components/ui/app-link";
import { EXTENSION_DOWNLOAD_URL } from "@/lib/extension/links";
import styles from "./extension.module.css";

type Device = { id: string; name: string; pairedAt: string | null; lastSeenAt: string | null };
const headers = { "x-grove-csrf": "1" };

function ago(iso: string | null) {
  if (!iso) return "never used";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 2) return "used just now";
  if (minutes < 60) return `used ${minutes} min ago`;
  if (minutes < 60 * 24) return `used ${Math.round(minutes / 60)} h ago`;
  return `used ${Math.round(minutes / 1440)} d ago`;
}

export function ExtensionDevices() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/canvas/extension/devices", { headers, cache: "no-store" });
      if (!response.ok) throw new Error();
      setDevices((await response.json()).devices);
      setError("");
    } catch { setError("Could not load connected browsers."); }
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/canvas/extension/devices", { headers, cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("load"))))
      .then((body) => { if (live) setDevices(body.devices); })
      .catch(() => { if (live) setError("Could not load connected browsers."); });
    return () => { live = false; };
  }, []);

  async function disconnect(id: string) {
    setDevices((current) => current?.filter((d) => d.id !== id) ?? null);
    const response = await fetch(`/api/canvas/extension/devices/${id}`, { method: "DELETE", headers });
    if (!response.ok) { setError("Could not disconnect that browser."); void load(); }
  }

  return <section id="extension" className="panel" aria-labelledby="extension-heading">
    <div className={styles.head}>
      <div><h2 id="extension-heading">Browser extension</h2><p>Open Canvas links, Gradescope and New Quizzes from Grove with your Canvas session already in the browser.</p></div>
      <div className="page-actions"><AppLink className="button primary" href="/extension/connect">Connect a browser</AppLink><a className="button secondary" href={EXTENSION_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">Get the extension</a></div>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {devices === null && !error ? <p className={styles.empty}>Loading…</p> : null}
    {devices?.length === 0 ? <p className={styles.empty}>No browsers connected yet.</p> : null}
    {devices?.length ? <ul className={styles.list}>{devices.map((device) => <li key={device.id} className={styles.device}>
      <div><div className={styles.deviceName}>{device.name}</div><div className={styles.deviceMeta}>{ago(device.lastSeenAt)}</div></div>
      <button type="button" className="danger-button" onClick={() => disconnect(device.id)} aria-label={`Disconnect ${device.name}`}>Disconnect</button>
    </li>)}</ul> : null}
  </section>;
}
