# Canvas Grove visual/product release gate

This QA suite is non-destructive. Screenshots belong under Playwright output directories and must not be shipped as product assets.

## Required matrix

- 1440×900 desktop, 1024×768 tablet, 390×844 mobile.
- Light and dark; normal and reduced motion.
- Today, Planner, Courses/list/detail/tabs, Files, Syllabus, Grades/What-If, Quizzes/list/preflight/attempt/results, Inbox, Settings/connection/orientation.
- Populated, empty, loading, offline, unresponsive, auth-required, and error states.
- Horizontal overflow, scrolling, focus visibility, keyboard order/actions, navigation, Unicode/mojibake, popup lifecycle.

## Secure viewer gate

The viewer must open from the direct user click in a dedicated named popup, reuse/focus that window, recover when blocked or closed, pass responsive dimensions, never embed credential entry beside the app, detect completion automatically, and revoke/disable the viewer when cancelled. Each offline, starting, unresponsive, and auth-required state must be distinguishable and actionable.

Run `npx tsx --test tests/viewer-release-gate.test.ts` against every integrated candidate. Any failure blocks release.
