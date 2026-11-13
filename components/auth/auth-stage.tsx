import { Suspense, type ReactNode } from "react";

// Clerk's <SignIn/>/<SignUp/> stop rendering their card once auth completes (and on the
// sso-callback step) while they push to "/". That hop can take seconds for a new account,
// so the "finishing" status sits in the same grid cell underneath the card: hidden by the
// opaque card while it is visible, and on screen the moment the card goes away.
export function AuthStage({ children, finishing }: { children: ReactNode; finishing: string }) {
  return (
    <div className="auth-stage">
      <div className="auth-stage-finishing" role="status" aria-live="polite">
        <span className="viewer-spinner" aria-hidden="true" />
        <p>{finishing}</p>
      </div>
      <div className="auth-stage-card">
        <Suspense>{children}</Suspense>
      </div>
    </div>
  );
}
