"use client";

import { useEffect, useState } from "react";
import { AUTO_TIME_ZONE, resolveTimeZone } from "@/lib/time";

export function useDisplayTimeZone() {
  const browserZone = typeof Intl === "undefined" ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [zone, setZone] = useState(() => resolveTimeZone(AUTO_TIME_ZONE, browserZone));
  useEffect(() => {
    let active = true;
    fetch("/api/preferences/timezone", { cache: "no-store" })
      .then(response => response.ok ? response.json() : Promise.reject())
      .then((value: { timezone?: unknown }) => { if (active) setZone(resolveTimeZone(value.timezone, browserZone)); })
      .catch(() => { if (active) setZone(resolveTimeZone(AUTO_TIME_ZONE, browserZone)); });
    return () => { active = false; };
  }, [browserZone]);
  return zone;
}
