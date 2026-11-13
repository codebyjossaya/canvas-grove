FROM debian:bookworm-slim

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    chromium xvfb x11vnc novnc websockify openbox ca-certificates fonts-liberation dumb-init socat dbus \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin browser \
    && mkdir -p /profile /run/browser \
    && chown -R browser:browser /profile /run/browser

COPY --chown=browser:browser start-browser.sh /usr/local/bin/start-browser
RUN chmod 0555 /usr/local/bin/start-browser

# Enterprise policy (root-owned, read-only to the browser user): the hosted
# browser must never offer to save, autofill or leak-check credentials, and must
# not show sign-in/sync/translate prompts over institution login pages.
# It also keeps keyboard-reachable browser UI inert: DevTools/view-source/file URLs
# are blocklisted, a new tab/window opens on chrome://version/ (which the relay
# guard closes), and incognito/guest/downloads/printing are off. Do NOT set
# DeveloperToolsAvailability=2: it also blocks CDP page attach, which breaks
# sign-in detection. The viewer drops browser-UI shortcuts before they get here.
COPY chromium-policy.json /etc/chromium/policies/managed/canvas-grove.json
RUN chmod 0444 /etc/chromium/policies/managed/canvas-grove.json

# Built-in extension that rejects WebAuthn so no passkey/security-key dialog can
# ever open (see no-passkeys/no-passkeys.js). Root-owned and read-only.
COPY no-passkeys /opt/canvas-grove/no-passkeys
RUN chmod 0555 /opt/canvas-grove/no-passkeys && chmod 0444 /opt/canvas-grove/no-passkeys/*

USER 10001:10001
WORKDIR /home/browser
EXPOSE 6080 9222
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/start-browser"]
