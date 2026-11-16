"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ErrorNotice } from "./error-notice";
import { safeBlockedHostname, toUiError, type UiError } from "./ui-errors";
import { InteractiveAuthCountdown } from "./interactive-auth-countdown";
import { shouldShowInteractiveAuthDeadline } from "@/lib/interactive-auth-deadline";
import {
  SECURE_BROWSER_WINDOW_NAME,
  secureBrowserPopupFeatures,
} from "@/lib/popup-window";
import { parseInstitutionLink } from "@/lib/canvas/institution";
import { CANVAS_CONSENT_VERSION as CONSENT_VERSION } from "@/lib/canvas/consent-version";
import { AppLink } from "./app-link";

const POLL_MS = 3000;
// While the secure-browser window is open the user is mid sign-in: poll fast so
// completion is reflected within about a second. The overall budget is unchanged.
const POPUP_OPEN_POLL_MS = 1000;
const MAX_POLL_DURATION_MS = 200 * POLL_MS;
const SCHOOL_SEARCH_DEBOUNCE_MS = 300;

type School = { name: string; domain: string };
type SchoolSearchStatus = "idle" | "loading" | "done" | "error";

type Session = {
  id: string;
  canvasOrigin: string;
  institutionName: string;
  state:
    | "provisioning"
    | "awaiting-login"
    | "active"
    | "auth-expired"
    | "terminated"
    | "failed";
  updatedAt: string;
  interactiveAuthExpiresAt: string | null;
  lastError?: string;
};
type Phase =
  | "idle"
  | "agent-opening"
  | "viewer-loading"
  | "takeover"
  | "verifying"
  | "connected";
type PopupState = "idle" | "open" | "blocked" | "closed";

class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public blockedHost?: string,
  ) {
    super(message);
  }
}

type ExtensionAuthResult = {
  ok?: boolean;
  reason?: string;
  installed?: boolean;
  paired?: boolean;
  signedIn?: boolean;
  account?: { id: string; name: string };
};

function extensionRequest(type: "canvas-auth-state" | "canvas-auth-open" | "canvas-auth-check" | "canvas-auth-capture", payload: Record<string, unknown> = {}, timeoutMs = 6000) {
  return new Promise<ExtensionAuthResult>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const done = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; requestId?: string; result?: ExtensionAuthResult };
      if (event.source !== window || event.origin !== window.location.origin || data?.source !== "grove-extension" || data.type !== "canvas-auth-result" || data.requestId !== requestId) return;
      cleanup();
      resolve(data.result ?? { ok: false, reason: "unavailable" });
    };
    const timer = window.setTimeout(() => { cleanup(); reject(new ApiError("Install and connect the Grove browser extension before signing in to Canvas.", "EXTENSION_REQUIRED", 409)); }, timeoutMs);
    const cleanup = () => { window.clearTimeout(timer); window.removeEventListener("message", done); };
    window.addEventListener("message", done);
    window.postMessage({ source: "grove-web", type, requestId, ...payload }, window.location.origin);
  });
}

async function api<T>(url: string, init?: RequestInit) {
  try {
    const response = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    const value = (await response.json().catch(() => ({}))) as T & {
      error?: string;
      code?: string;
      blockedHost?: unknown;
    };
    if (!response.ok)
      throw new ApiError(
        value.error || "Request failed",
        value.code || "REQUEST_FAILED",
        response.status,
        safeBlockedHostname(value.blockedHost),
      );
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      error instanceof Error ? error.message : "Network request failed",
      navigator.onLine ? "SERVER_UNAVAILABLE" : "NETWORK_OFFLINE",
      0,
    );
  }
}

export function CanvasSessionManager() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [signInLink, setSignInLink] = useState("");
  const [signInLinkError, setSignInLinkError] = useState("");
  const [entryMode, setEntryMode] = useState<"search" | "link">("search");
  const [schoolQuery, setSchoolQuery] = useState("");
  const [schoolResults, setSchoolResults] = useState<School[]>([]);
  const [schoolSearchStatus, setSchoolSearchStatus] =
    useState<SchoolSearchStatus>("idle");
  const [schoolSearchError, setSchoolSearchError] = useState("");
  const [activeSchool, setActiveSchool] = useState(-1);
  const [selectedSchool, setSelectedSchool] = useState<School | null>(null);
  const [institutionName, setInstitutionName] = useState("");
  const [consent, setConsent] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [popupState, setPopupState] = useState<PopupState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [checkResult, setCheckResult] = useState("");
  const [clientExpiredSessionId, setClientExpiredSessionId] = useState<string>();
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [detectedAccount, setDetectedAccount] = useState<{ id: string; name: string } | null>(null);
  const [extensionStatus, setExtensionStatus] = useState<"checking" | "ready" | "missing" | "unpaired">("checking");
  const sessionHeading = useRef<HTMLHeadingElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const flight = useRef(false);
  const poll = useRef<number>(undefined);
  const started = useRef(0);
  const popup = useRef<Window | null>(null);
  const popupWatch = useRef<number>(undefined);
  const completing = useRef(false);
  const viewerTimer = useRef<number>(undefined);
  const operation = useRef(0);
  const schoolSearchTimer = useRef<number>(undefined);
  const schoolSearchRequest = useRef(0);
  const schoolSearchAbort = useRef<AbortController | null>(null);
  const extensionPoll = useRef<number>(undefined);
  const orientationPrefillApplied = useRef(false);
  const reviewOrigin = (() => {
    try {
      return parseInstitutionLink(signInLink).canvasOrigin;
    } catch {
      return signInLink;
    }
  })();
  const current = sessions.find(
    (session) => session.state !== "terminated" && session.state !== "failed",
  );
  const interactiveTimedOut = Boolean(
    current &&
      (current.lastError === "INTERACTIVE_AUTH_TIMEOUT" ||
        clientExpiredSessionId === current.id),
  );
  const needsInteractiveAttempt = Boolean(
    current &&
      current.state !== "active" &&
      !current.interactiveAuthExpiresAt &&
      !interactiveTimedOut,
  );

  const showError = useCallback((value: unknown, fallback = "UNKNOWN") => {
    const code = value instanceof ApiError ? value.code : fallback;
    setError(toUiError(value, codeMap(code)));
  }, []);
  const refresh = useCallback(async () => {
    try {
      const value = await api<{ sessions: Session[] }>("/api/canvas/sessions");
      setSessions(value.sessions);
      const timedOut = value.sessions.find(
        (session) => session.lastError === "INTERACTIVE_AUTH_TIMEOUT",
      );
      if (timedOut) setClientExpiredSessionId(timedOut.id);
      if (value.sessions.some((session) => session.state === "active"))
        setPhase("connected");
      setError(null);
    } catch (value) {
      showError(value);
    } finally {
      setLoading(false);
    }
  }, [showError]);

  function begin() {
    if (flight.current) return false;
    flight.current = true;
    started.current = Date.now();
    setElapsed(0);
    setBusy(true);
    setError(null);
    return true;
  }
  function end() {
    flight.current = false;
    setBusy(false);
  }

  useEffect(() => {
    const id = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(id);
  }, [refresh]);
  useEffect(() => {
    let alive = true;
    extensionRequest("canvas-auth-state", {}, 1800).then((value) => {
      if (alive) setExtensionStatus(value.installed && value.paired ? "ready" : value.installed ? "unpaired" : "missing");
    }, () => { if (alive) setExtensionStatus("missing"); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (orientationPrefillApplied.current) return;
    orientationPrefillApplied.current = true;
    const params = new URLSearchParams(window.location.search);
    const name = params.get("canvasSchoolName")?.trim().slice(0, 120) ?? "";
    const domain = params.get("canvasSchoolDomain")?.trim().slice(0, 300) ?? "";
    if (!name || !domain) return;
    try {
      const parsed = parseInstitutionLink(domain);
      setEntryMode("search");
      setSelectedSchool({ name, domain });
      setSchoolQuery(name);
      setInstitutionName(name);
      setSignInLink(`${parsed.canvasOrigin}/login`);
      setSignInLinkError("");
      params.delete("canvasSchoolName");
      params.delete("canvasSchoolDomain");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    } catch {
      setSignInLinkError("The school selected during orientation has an invalid Canvas address. Search for it again.");
    }
  }, []);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - started.current) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [busy]);
  useEffect(() => {
    if (confirmingDelete) deleteCancel.current?.focus();
  }, [confirmingDelete]);
  useEffect(
    () => () => {
      if (poll.current) clearTimeout(poll.current);
      if (viewerTimer.current) clearTimeout(viewerTimer.current);
      if (popupWatch.current) clearInterval(popupWatch.current);
      if (schoolSearchTimer.current) clearTimeout(schoolSearchTimer.current);
      if (extensionPoll.current) clearTimeout(extensionPoll.current);
      schoolSearchAbort.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== popup.current
      )
        return;
      const message = event.data as {
        source?: string;
        type?: string;
        detail?: string;
        code?: string;
        blockedHost?: unknown;
      };
      if (message?.source !== "canvas-grove-popup") return;
      if (message.type === "shell-ready") {
        setPhase("viewer-loading");
        return;
      }
      if (message.type === "viewer-loading") {
        setPhase("viewer-loading");
        return;
      }
      if (message.type === "ws-ready") {
        if (viewerTimer.current) clearTimeout(viewerTimer.current);
        setPhase("takeover");
        setError(null);
        end();
        return;
      }
      if (message.type === "completed") {
        // The popup confirmed sign-in server-side and is closing itself. Detach
        // it first so its closure is not reported as an abandoned sign-in, and
        // keep polling fast until the active session is observed here.
        completing.current = true;
        popup.current = null;
        setPopupState("closed");
        setPhase("verifying");
        setError(null);
        return;
      }
      if (message.type === "closed") {
        setPopupState("closed");
        if (phase !== "connected") {
          end();
          setError(
            toUiError(
              "The secure browser window was closed before sign-in finished.",
              "POPUP_CLOSED",
            ),
          );
        }
        return;
      }
      if (
        ["failed", "disconnected", "authorization-expired", "ended"].includes(
          message.type || "",
        )
      ) {
        if (viewerTimer.current) clearTimeout(viewerTimer.current);
        end();
        setPhase("takeover");
        showError(
          new ApiError(
            message.detail || "The secure live browser could not connect",
            message.type === "authorization-expired"
              ? "BROWSER_AUTH_EXPIRED"
              : message.code || "BROWSER_HOST_ERROR",
            503,
            safeBlockedHostname(message.blockedHost),
          ),
        );
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [phase, showError]);

  function changeSchoolQuery(value: string) {
    setSchoolQuery(value);
    setActiveSchool(-1);
    setSchoolSearchError("");
    if (schoolSearchTimer.current) clearTimeout(schoolSearchTimer.current);
    schoolSearchAbort.current?.abort();
    const request = ++schoolSearchRequest.current;
    const query = value.replace(/\s+/g, " ").trim().slice(0, 80);
    if (query.length < 2) {
      setSchoolResults([]);
      setSchoolSearchStatus("idle");
      return;
    }
    setSchoolSearchStatus("loading");
    schoolSearchTimer.current = window.setTimeout(async () => {
      const controller = new AbortController();
      schoolSearchAbort.current = controller;
      try {
        const found = await api<{ results: School[] }>(
          `/api/canvas/institutions/search?q=${encodeURIComponent(query)}`,
          { signal: controller.signal },
        );
        if (request !== schoolSearchRequest.current) return;
        setSchoolResults(Array.isArray(found.results) ? found.results : []);
        setSchoolSearchStatus("done");
      } catch (value) {
        if (request !== schoolSearchRequest.current) return;
        setSchoolResults([]);
        setSchoolSearchStatus("error");
        setSchoolSearchError(
          value instanceof Error ? value.message : "School search failed",
        );
      }
    }, SCHOOL_SEARCH_DEBOUNCE_MS);
  }
  function selectSchool(school: School) {
    if (schoolSearchTimer.current) clearTimeout(schoolSearchTimer.current);
    schoolSearchAbort.current?.abort();
    schoolSearchRequest.current += 1;
    setSchoolResults([]);
    setSchoolSearchStatus("idle");
    setActiveSchool(-1);
    // The secure browser opens the school's plain Canvas /login. If that lands
    // on a page of sign-in buttons, the user picks theirs inside the secure
    // browser; the server discovers every host those buttons need.
    let link = "";
    try {
      link = `${parseInstitutionLink(school.domain).canvasOrigin}/login`;
    } catch {
      setSignInLinkError("That school's Canvas address is not supported");
      return;
    }
    setSelectedSchool(school);
    setSchoolQuery(school.name);
    setSignInLink(link);
    setSignInLinkError("");
  }
  function clearSchool() {
    schoolSearchRequest.current += 1;
    setSelectedSchool(null);
    setSignInLink("");
    setSignInLinkError("");
    setSchoolQuery("");
    setSchoolResults([]);
    setSchoolSearchStatus("idle");
  }
  function switchEntryMode(mode: "search" | "link") {
    if (schoolSearchTimer.current) clearTimeout(schoolSearchTimer.current);
    schoolSearchAbort.current?.abort();
    clearSchool();
    setEntryMode(mode);
  }
  function onSchoolKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      // Never submit the outer form from the search box.
      event.preventDefault();
      const target =
        activeSchool >= 0
          ? schoolResults[activeSchool]
          : schoolResults.length === 1
            ? schoolResults[0]
            : undefined;
      if (target) selectSchool(target);
      return;
    }
    if (!schoolResults.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSchool((index) => (index + 1) % schoolResults.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSchool((index) =>
        index <= 0 ? schoolResults.length - 1 : index - 1,
      );
    } else if (event.key === "Escape") {
      event.preventDefault();
      setSchoolResults([]);
      setActiveSchool(-1);
      setSchoolSearchStatus("idle");
    }
  }
  function requestReview(event: FormEvent) {
    event.preventDefault();
    if (!consent) return;
    if (entryMode === "search" && !signInLink) {
      setSignInLinkError("Search for your school and pick it from the list");
      return;
    }
    try {
      parseInstitutionLink(signInLink);
      setSignInLinkError("");
      setReviewing(true);
    } catch (value) {
      setSignInLinkError(
        value instanceof Error
          ? value.message
          : "Paste your school's Canvas sign-in link or address",
      );
    }
  }
  function monitorPopup(target: Window) {
    if (popupWatch.current) clearInterval(popupWatch.current);
    popupWatch.current = window.setInterval(() => {
      if (!target.closed) return;
      clearInterval(popupWatch.current);
      popupWatch.current = undefined;
      if (popup.current === target) {
        popup.current = null;
        setPopupState("closed");
        end();
        setError(
          toUiError(
            "The secure browser window was closed before sign-in finished.",
            "POPUP_CLOSED",
          ),
        );
      }
    }, 500);
  }
  function openPopup(path: string) {
    const existing = popup.current;
    if (existing && !existing.closed) {
      try {
        existing.location.href = path;
      } catch {
        /* The named window will navigate below when reopened. */
      }
      existing.focus();
      setPopupState("open");
      return existing;
    }
    const target = window.open(
      path,
      SECURE_BROWSER_WINDOW_NAME,
      secureBrowserPopupFeatures(window.screen),
    );
    if (!target) {
      setPopupState("blocked");
      showError(
        new ApiError(
          "The secure browser popup was blocked",
          "POPUP_BLOCKED",
          0,
        ),
      );
      return null;
    }
    popup.current = target;
    setPopupState("open");
    target.focus();
    monitorPopup(target);
    return target;
  }
  function closePopup() {
    const target = popup.current;
    if (target && !target.closed) {
      target.postMessage(
        { source: "canvas-grove-opener", type: "end" },
        window.location.origin,
      );
      target.close();
    }
    popup.current = null;
    setPopupState("closed");
  }
  function focusOrReopen(session: Session) {
    const target = popup.current;
    if (target && !target.closed) {
      target.focus();
      setPopupState("open");
      return;
    }
    launchExisting(session);
  }
  function startPolling(id: string) {
    let failures = 0;
    const startedAt = Date.now();
    completing.current = false;
    const nextDelay = () =>
      completing.current || (popup.current && !popup.current.closed)
        ? POPUP_OPEN_POLL_MS
        : POLL_MS;
    const tick = async () => {
      try {
        const value = await api<{ session: Session }>(
          `/api/canvas/sessions/${id}`,
        );
        failures = 0;
        setSessions([value.session]);
        if (value.session.state === "active") {
          setPhase("verifying");
          setError(null);
          closePopup();
          window.focus();
          poll.current = window.setTimeout(() => {
            setPhase("connected");
            end();
          }, 650);
          return;
        }
        if (
          ["auth-expired", "failed", "terminated"].includes(value.session.state)
        ) {
          const timedOut = value.session.lastError === "INTERACTIVE_AUTH_TIMEOUT";
          if (timedOut) setClientExpiredSessionId(value.session.id);
          setPhase("takeover");
          showError(
            new ApiError(
              timedOut
                ? "The interactive sign-in attempt expired"
                : value.session.state === "auth-expired"
                ? "Canvas sign-in expired"
                : "The secure browser stopped before sign-in finished",
              timedOut
                ? "INTERACTIVE_AUTH_TIMEOUT"
                : value.session.state === "auth-expired"
                ? "BROWSER_AUTH_EXPIRED"
                : "BROWSER_HOST_ERROR",
              503,
            ),
          );
          end();
          return;
        }
      } catch (value) {
        failures += 1;
        if (
          failures >= 3 ||
          (value instanceof ApiError &&
            value.code === "BROWSER_SESSION_NOT_FOUND")
        ) {
          setPhase("takeover");
          showError(value, "SERVER_UNAVAILABLE");
          end();
          return;
        }
      }
      if (Date.now() - startedAt < MAX_POLL_DURATION_MS)
        poll.current = window.setTimeout(tick, nextDelay());
      else {
        setPhase("takeover");
        setError(toUiError("Verification timed out", "VERIFY_PENDING"));
        end();
      }
    };
    if (poll.current) clearTimeout(poll.current);
    poll.current = window.setTimeout(tick, nextDelay());
  }
  function connectPopup(session: Session, target: Window, op: number) {
    if (op !== operation.current || target.closed) return;
    target.location.replace(
      `/secure-browser/${encodeURIComponent(session.id)}`,
    );
    target.focus();
    setPopupState("open");
    setPhase("viewer-loading");
    startPolling(session.id);
    viewerTimer.current = window.setTimeout(() => {
      if (op !== operation.current) return;
      end();
      setPhase("takeover");
      showError(
        new ApiError(
          "The secure live browser did not establish a connection",
          "BROWSER_HOST_ERROR",
          503,
        ),
      );
    }, 25_000);
  }
  async function prepareAttemptAndConnect(
    session: Session,
    target: Window,
    op: number,
    forceNewAttempt = false,
  ) {
    try {
      let ready = session;
      if (forceNewAttempt || !session.interactiveAuthExpiresAt) {
        const value = await api<{ session: Session }>(
          `/api/canvas/sessions/${session.id}/auth-attempt`,
          { method: "POST", signal: AbortSignal.timeout(30_000) },
        );
        ready = value.session;
      }
      if (op !== operation.current || target.closed) return;
      setSessions([ready]);
      setClientExpiredSessionId(undefined);
      connectPopup(ready, target, op);
    } catch (value) {
      if (op === operation.current) {
        closePopup();
        setPhase("takeover");
        showError(value);
        end();
      }
    }
  }
  async function createAndLaunch() {
    if (!consent || flight.current) return;
    if (!begin()) return;
    const op = ++operation.current;
    setReviewing(false);
    setPhase("agent-opening");
    setDetectedAccount(null);
    try {
      const created = await api<{ session: Session }>("/api/canvas/sessions", {
        method: "POST",
        body: JSON.stringify({
          signInLink,
          institutionName:
            institutionName.trim() ||
            (entryMode === "search" && selectedSchool
              ? selectedSchool.name.slice(0, 100)
              : ""),
          consent: true,
          consentVersion: CONSENT_VERSION,
        }),
      });
      if (op !== operation.current) return;
      setSessions([created.session]);
      await openExtensionSignIn(created.session, signInLink);
    } catch (value) {
      if (op === operation.current) {
        setPhase("takeover");
        showError(value);
        end();
      }
    }
  }
  function extensionFailure(result: ExtensionAuthResult) {
    const messages: Record<string, string> = {
      "not-connected": "Connect the Grove browser extension to your account first.",
      "permission-required": "Open the Grove extension from your browser toolbar, choose Allow access to Canvas, then try again.",
      "not-signed-in": "Finish signing in to Canvas in the popup that opened.",
      "popup-failed": "Your browser could not open the Canvas sign-in popup. Allow popups for Grove, then try again.",
      "auth-mismatch": "This sign-in attempt changed. Start again from Grove.",
      "auth-expired": "This Canvas sign-in attempt expired. Start a new sign-in from Grove.",
    };
    return new ApiError(messages[result.reason ?? ""] ?? "The Grove extension could not complete Canvas sign-in.", result.reason === "not-connected" ? "EXTENSION_REQUIRED" : "EXTENSION_AUTH_FAILED", 409);
  }
  function watchExtensionSignIn(session: Session) {
    if (extensionPoll.current) clearTimeout(extensionPoll.current);
    const check = async () => {
      try {
        const result = await extensionRequest("canvas-auth-check", { sessionId: session.id, canvasOrigin: session.canvasOrigin });
        if (result.ok && result.signedIn && result.account) {
          setDetectedAccount(result.account);
          setPhase("verifying");
          setError(null);
          await finishExtensionAuth(session);
          return;
        }
      } catch { /* The user may still be on the institution sign-in page. */ }
      extensionPoll.current = window.setTimeout(check, 2000);
    };
    extensionPoll.current = window.setTimeout(check, 1200);
  }
  async function openExtensionSignIn(session: Session, value = `${session.canvasOrigin}/login`) {
    let loginUrl = `${session.canvasOrigin}/login`;
    try {
      const parsed = parseInstitutionLink(value);
      loginUrl = `${parsed.canvasOrigin}${parsed.loginPath}`;
    } catch { /* The stored exact origin remains the safe fallback. */ }
    const state = await extensionRequest("canvas-auth-state");
    if (!state.installed || !state.paired) throw extensionFailure({ ok: false, reason: "not-connected" });
    const opened = await extensionRequest("canvas-auth-open", { sessionId: session.id, canvasOrigin: session.canvasOrigin, loginUrl }, 10_000);
    if (!opened.ok) throw extensionFailure(opened);
    setPhase("takeover");
    setPopupState("open");
    end();
    watchExtensionSignIn(session);
  }
  async function finishExtensionAuth(session: Session) {
    if (!begin()) return;
    if (extensionPoll.current) clearTimeout(extensionPoll.current);
    setPhase("verifying");
    try {
      const captured = await extensionRequest("canvas-auth-capture", { sessionId: session.id, canvasOrigin: session.canvasOrigin }, 30_000);
      if (!captured.ok) throw extensionFailure(captured);
      await refresh();
      setDetectedAccount(null);
      setPhase("connected");
      setPopupState("closed");
    } catch (value) { showError(value); }
    finally { end(); }
  }
  function launchExisting(session: Session) {
    if (flight.current) return;
    if (
      session.lastError === "INTERACTIVE_AUTH_TIMEOUT" ||
      clientExpiredSessionId === session.id
    ) {
      setError(
        toUiError(
          "The interactive sign-in attempt expired",
          "INTERACTIVE_AUTH_TIMEOUT",
        ),
      );
      return;
    }
    if (!begin()) return;
    ++operation.current;
    setPhase("agent-opening");
    setError(null);
    setPopupState("open");
    setDetectedAccount(null);
    void openExtensionSignIn(session).catch((value) => { showError(value); end(); });
  }
  async function startNewInteractiveAttempt(session: Session) {
    if (flight.current) return;
    if (!begin()) return;
    ++operation.current;
    setConfirmingRestart(false);
    setPhase("agent-opening");
    try {
      const value = await api<{ session: Session }>(`/api/canvas/sessions/${session.id}/auth-attempt`, { method: "POST", signal: AbortSignal.timeout(30_000) });
      setSessions([value.session]);
      await openExtensionSignIn(value.session);
    } catch (value) { showError(value); end(); }
  }
  async function remove(session: Session) {
    operation.current += 1;
    flight.current = false;
    if (poll.current) clearTimeout(poll.current);
    if (viewerTimer.current) clearTimeout(viewerTimer.current);
    closePopup();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/canvas/sessions/${session.id}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(30_000),
      });
      setSessions([]);
      setClientExpiredSessionId(undefined);
      setConfirmingRestart(false);
      setConfirmingDelete(false);
      setPopupState("idle");
      setPhase("idle");
      setReviewing(false);
      window.requestAnimationFrame(() => sessionHeading.current?.focus());
    } catch (value) {
      showError(value);
      await refresh();
    } finally {
      end();
    }
  }
  async function checkConnection(session: Session) {
    if (!begin()) return;
    setCheckResult("");
    try {
      const value = await api<{ session: Session }>(
        `/api/canvas/sessions/${session.id}?verify=1`,
        { signal: AbortSignal.timeout(30_000) },
      );
      setSessions((items) =>
        items.map((item) =>
          item.id === value.session.id ? value.session : item,
        ),
      );
      if (value.session.state !== "active")
        throw new ApiError(
          "Canvas needs you to sign in again",
          value.session.state === "auth-expired"
            ? "BROWSER_AUTH_EXPIRED"
            : "BROWSER_HOST_ERROR",
          409,
        );
      setPhase("connected");
      setError(null);
      setCheckResult(
        `Connection verified at ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date())}.`,
      );
    } catch (value) {
      showError(value);
    } finally {
      end();
    }
  }

  const label =
    current?.state === "active"
      ? "Connected"
      : needsInteractiveAttempt
        ? "Sign-in needed"
      : current?.state === "auth-expired"
        ? "Expired"
        : current
          ? "Starting"
          : "Not connected";
  return (
    <section
      className="session-card handoff"
      aria-labelledby="session-title"
      aria-busy={loading || busy}
    >
      <div>
        <p className="eyebrow">Canvas connection</p>
        <h2 id="session-title" ref={sessionHeading} tabIndex={-1}>
          {current ? `${label} to Canvas` : "Connect your Canvas account"}
        </h2>
        <p>
          Sign in through Canvas in this browser. After Canvas recognizes you,
          the Grove extension sends only this Canvas site&apos;s session cookies to
          Grove for verification; passwords and multi-factor prompts stay local.
        </p>
        {current && (
          <div className="status-row">
            <span
              className={`status ${current.state === "active" ? "connected" : current.state === "auth-expired" ? "expired" : "starting"}`}
            >
              <i />
              {label}
            </span>
            <span className="status">{current.canvasOrigin}</span>
            {busy && <span className="status">{elapsed}s</span>}
          </div>
        )}
        {current && current.state !== "active" && <PhaseList phase={phase} />}{" "}
        {current &&
          shouldShowInteractiveAuthDeadline(current) &&
          !interactiveTimedOut && (
            <InteractiveAuthCountdown
              expiresAt={current.interactiveAuthExpiresAt!}
              onExpire={() => {
                setClientExpiredSessionId(current.id);
                closePopup();
                setError(
                  toUiError(
                    "The interactive sign-in attempt expired",
                    "INTERACTIVE_AUTH_TIMEOUT",
                  ),
                );
              }}
            />
          )}
        {error && (
          <ErrorNotice
            error={error}
            onRetry={
              current && !interactiveTimedOut
                ? () => launchExisting(current)
                : undefined
            }
          />
        )}
      </div>
      <div className="session-actions">
        {!current && !reviewing ? (
          <form onSubmit={requestReview}>
            {extensionStatus !== "ready" ? <div className="connection-success" role="status">
              <strong>{extensionStatus === "checking" ? "Checking the Grove extension…" : extensionStatus === "unpaired" ? "Connect the Grove extension" : "Install the Grove extension"}</strong>
              <span>Canvas authentication happens in this browser, so the extension is required before continuing.</span>
              {extensionStatus !== "checking" ? <AppLink className="button secondary" href="/extension/connect">Install or connect extension</AppLink> : null}
            </div> : <div className="connection-success" role="status"><strong>Browser extension ready</strong><span>Your Canvas sign-in will stay in this browser.</span></div>}
            {entryMode === "search" ? (
              selectedSchool ? (
                <div className="school-selected">
                  <span id="school-selected-label">Your school</span>
                  <strong aria-describedby="school-selected-label">
                    {selectedSchool.name}
                  </strong>
                  <span className="school-domain">{selectedSchool.domain}</span>
                  <small>
                    If your school offers several ways to sign in, you will
                    choose yours on its normal Canvas sign-in page.
                  </small>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={clearSchool}
                  >
                    Change school
                  </button>
                </div>
              ) : (
                <div className="school-search">
                  <label htmlFor="school-search">Your school</label>
                  <input
                    id="school-search"
                    type="search"
                    role="combobox"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={80}
                    aria-autocomplete="list"
                    aria-expanded={schoolResults.length > 0}
                    aria-controls="school-search-results"
                    aria-activedescendant={
                      activeSchool >= 0
                        ? `school-option-${activeSchool}`
                        : undefined
                    }
                    aria-describedby="school-search-help"
                    aria-invalid={signInLinkError ? true : undefined}
                    value={schoolQuery}
                    onChange={(event) => changeSchoolQuery(event.target.value)}
                    onKeyDown={onSchoolKeyDown}
                    placeholder="Start typing your school's name"
                  />
                  <small id="school-search-help">
                    Search by name, then choose your school from the list.
                  </small>
                  <ul
                    id="school-search-results"
                    role="listbox"
                    aria-label="Matching schools"
                    className="school-results"
                    hidden={schoolResults.length === 0}
                  >
                    {schoolResults.map((school, index) => (
                      <li
                        key={`${school.domain}|${school.name}`}
                        id={`school-option-${index}`}
                        role="option"
                        aria-selected={index === activeSchool}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => selectSchool(school)}
                      >
                        <strong>{school.name}</strong>
                        <span className="school-domain">{school.domain}</span>
                      </li>
                    ))}
                  </ul>
                  {schoolSearchStatus === "done" && !schoolResults.length && (
                    <small>
                      No schools matched. Try another name, or enter your
                      Canvas address instead.
                    </small>
                  )}
                  {schoolSearchStatus === "error" && (
                    <small role="alert">{schoolSearchError}</small>
                  )}
                </div>
              )
            ) : (
              <>
                <label htmlFor="canvas-sign-in-link">
                  Your school&apos;s Canvas address or sign-in link
                </label>
                <input
                  id="canvas-sign-in-link"
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  required
                  value={signInLink}
                  aria-describedby="canvas-sign-in-link-help"
                  aria-invalid={signInLinkError ? true : undefined}
                  onChange={(event) => {
                    setSignInLink(event.target.value);
                    setSignInLinkError("");
                  }}
                  placeholder="school.instructure.com"
                />
                <small id="canvas-sign-in-link-help">
                  Enter the address you use for Canvas, like
                  school.instructure.com. A copied single sign-on link from
                  your school&apos;s Canvas login page also works.
                </small>
              </>
            )}
            <p className="sr-only" role="status" aria-live="polite">
              {schoolSearchStatus === "loading"
                ? "Searching for schools…"
                : schoolSearchStatus === "done"
                  ? schoolResults.length
                    ? `${schoolResults.length} school${schoolResults.length === 1 ? "" : "s"} found. Use the up and down arrow keys to choose.`
                    : "No schools matched."
                  : selectedSchool
                    ? `${selectedSchool.name} selected.`
                    : ""}
            </p>
            <button
              type="button"
              className="link-button"
              onClick={() =>
                switchEntryMode(entryMode === "search" ? "link" : "search")
              }
            >
              {entryMode === "search"
                ? "Enter a Canvas address or sign-in link instead"
                : "Search for your school instead"}
            </button>
            {signInLinkError && (
              <small role="alert">
                {signInLinkError}
              </small>
            )}
            <label htmlFor="institution-name">
              Institution name <small>(optional)</small>
            </label>
            <input
              id="institution-name"
              value={institutionName}
              maxLength={100}
              onChange={(event) => setInstitutionName(event.target.value)}
              placeholder={
                selectedSchool && entryMode === "search"
                  ? selectedSchool.name
                  : "Filled in from your Canvas address if left blank"
              }
            />
            <label className="consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>
                I understand that after Canvas recognizes me, the Grove
                extension will immediately send this Canvas site&apos;s session
                cookies to Grove over an encrypted connection for verification,
                and I can revoke the connection at any time.
              </span>
            </label>
            <button
              disabled={
                extensionStatus !== "ready" || !consent || busy || (entryMode === "search" && !signInLink)
              }
              className="button primary"
            >
              Review browser sign-in
            </button>
          </form>
        ) : !current && reviewing ? (
          <div
            className="viewer-review"
            role="dialog"
            aria-labelledby="viewer-review-title"
          >
            <span className="viewer-shield" aria-hidden="true">
              ✓
            </span>
            <strong id="viewer-review-title">Sign in on your browser</strong>
            <p>
              The Grove extension will open <b>{reviewOrigin}</b> in a dedicated
              browser popup. Check the address and complete your school&apos;s
              sign-in. Keep it open; Grove closes it automatically only after
              the session is verified.
            </p>
            <ul>
              <li>Your password and MFA stay in your browser</li>
              <li>Only cookies for this exact Canvas host are transferred</li>
              <li>The server re-verifies the session before saving it encrypted</li>
            </ul>
            <button
              className="button primary large"
              onClick={() => void createAndLaunch()}
            >
              Open Canvas sign-in
            </button>
            <button
              className="button secondary"
              onClick={() => setReviewing(false)}
            >
              Back
            </button>
            <small>
              The Grove extension must be installed and connected to this account.
            </small>
          </div>
        ) : current?.state === "active" ? (
          <>
            <div className="connection-success" role="status">
              <strong>Connected and syncing</strong>
              <span>Background sync continues while this app is closed.</span>
            </div>
            <button
              disabled={busy}
              className="button secondary"
              onClick={() => void checkConnection(current)}
            >
              {busy ? `Checking connection… ${elapsed}s` : "Check connection"}
            </button>
            {checkResult && (
              <p className="connection-check-result" role="status">
                {checkResult}
              </p>
            )}
            {!confirmingDelete ? <button
              ref={deleteTrigger}
              disabled={busy}
              className="danger-button"
              onClick={() => setConfirmingDelete(true)}
            >
              Disconnect &amp; delete session
            </button> : <div className="page-actions" role="group" aria-label="Confirm Canvas disconnection">
              <button disabled={busy} aria-busy={busy} className="danger-button" onClick={() => void remove(current)}>
                Confirm disconnect &amp; delete
              </button>
              <button ref={deleteCancel} disabled={busy} className="button ghost" onClick={() => { setConfirmingDelete(false); window.requestAnimationFrame(() => deleteTrigger.current?.focus()); }}>Keep connection</button>
            </div>}
          </>
        ) : current && interactiveTimedOut ? (
          <div className="interactive-auth-expired" role="status">
            <strong>Canvas sign-in time expired</strong>
            <span>
              The previous attempt ended. Your synced Canvas data is safe; start
              again to open a fresh local Canvas sign-in.
            </span>
            {!confirmingRestart ? (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => setConfirmingRestart(true)}
              >
                Start a new Canvas sign-in
              </button>
            ) : (
              <div
                className="interactive-auth-confirm"
                role="group"
                aria-label="Confirm new secure sign-in"
              >
                <p>
                  This ends the expired attempt and creates a fresh connection
                  request for the extension.
                </p>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void startNewInteractiveAttempt(current)}
                >
                  {busy
                    ? "Starting new Canvas sign-in…"
                    : "Start a new Canvas sign-in"}
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setConfirmingRestart(false)}
                >
                  Keep expired session
                </button>
              </div>
            )}
          </div>
        ) : current ? (
          <>
            <div className="popup-status" role="status" data-state={popupState}>
              <strong>
                {detectedAccount
                  ? `Canvas found: ${detectedAccount.name}`
                  : phase === "agent-opening"
                    ? "Opening Canvas in your browser"
                    : "Waiting for Canvas sign-in"}
              </strong>
              <span>
                {detectedAccount
                  ? `Connecting ${detectedAccount.name} and verifying the session with Canvas. The popup closes only after confirmation.`
                  : "Finish your school sign-in in the Canvas popup and keep it open. Grove will detect completion without seeing your password or MFA, then close it automatically after verification."}
              </span>
            </div>
            {detectedAccount ? error ? <button
              className="button primary"
              disabled={busy}
              onClick={() => void finishExtensionAuth(current)}
            >{busy ? "Connecting…" : "Retry Canvas verification"}</button> : <button
              className="button primary"
              disabled
              aria-busy="true"
            >Connecting {detectedAccount.name}…</button> : <button
              className="button secondary"
              disabled={busy}
              onClick={() => launchExisting(current)}
            >{busy ? "Opening Canvas…" : "Open Canvas sign-in again"}</button>}
            <button
              className="danger-button"
              onClick={() => void remove(current)}
            >
              Cancel &amp; revoke session
            </button>
          </>
        ) : null}
        <small>
          Grove never receives your institution password or multi-factor code.
        </small>
      </div>
    </section>
  );
}

function PhaseList({ phase }: { phase: Phase }) {
  const phases: [Phase, string][] = [
    ["agent-opening", "Opening Canvas in this browser"],
    ["viewer-loading", "Waiting for the Grove extension"],
    [
      "takeover",
      "Waiting for you to finish Canvas sign-in",
    ],
    ["verifying", "Verifying the detected Canvas session"],
    ["connected", "Connected and syncing"],
  ];
  const index = Math.max(
    0,
    phases.findIndex(([value]) => value === phase),
  );
  return (
    <ol
      className="handoff-phases"
      aria-label="Connection progress"
      aria-live="polite"
    >
      {phases.map(([value, itemLabel], itemIndex) => (
        <li
          key={value}
          className={
            itemIndex < index ? "done" : itemIndex === index ? "current" : ""
          }
          aria-current={itemIndex === index ? "step" : undefined}
        >
          <i />
          {itemLabel}
        </li>
      ))}
    </ol>
  );
}
function codeMap(code: string) {
  return (
    (
      {
        BROWSER_HOST_OFFLINE: "HOST_OFFLINE",
        BROWSER_HOST_CAPACITY: "HOST_CAPACITY",
        BROWSER_CAPACITY: "HOST_CAPACITY",
        BROWSER_AUTH_EXPIRED: "CANVAS_AUTH_EXPIRED",
        INTERACTIVE_AUTH_TIMEOUT: "INTERACTIVE_AUTH_TIMEOUT",
        BROWSER_HOST_AUTH: "AUTH_REQUIRED",
        BROWSER_HOST_ERROR: "SERVER_UNAVAILABLE",
        BROWSER_NAVIGATION_BLOCKED: "NAVIGATION_BLOCKED",
        BROWSER_SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
        SERVER_UNAVAILABLE: "SERVER_UNAVAILABLE",
        NETWORK_OFFLINE: "NETWORK_OFFLINE",
        POPUP_BLOCKED: "POPUP_BLOCKED",
        POPUP_CLOSED: "POPUP_CLOSED",
        VERIFY_PENDING: "VERIFY_PENDING",
        EXTENSION_REQUIRED: "AUTH_REQUIRED",
        EXTENSION_AUTH_FAILED: "UNKNOWN",
        CANVAS_AUTH_NOT_VERIFIED: "CANVAS_AUTH_EXPIRED",
        CANVAS_SESSION_COOKIE_MISSING: "CANVAS_AUTH_EXPIRED",
      } as Record<string, string>
    )[code] || "UNKNOWN"
  );
}
