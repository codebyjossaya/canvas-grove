"use client";

import { useEffect } from "react";

// Sliding "selected" indicator for segmented controls, single-select chips and tablists.
// Measures the one active child and publishes --sx/--sy/--sw/--sh on the container; the
// container's ::before (app/motion.css, `[data-slide]`) moves with translate/scale only.
// Keyboard moves, first placement and resizes snap instantly. Without JS nothing is marked
// and the controls keep their plain colour/press feedback.
const BOX = '[class*="segmented"],[class*="chips"],[role="tablist"]';
const ACTIVE = '[aria-pressed="true"],[aria-selected="true"],[aria-current="page"]';

export function SlideIndicators() {
  useEffect(() => {
    let instantAt = 0, frame = 0;
    const dirty = new Set<HTMLElement>();
    const place = (box: HTMLElement) => {
      const active = Array.from(box.children).filter(child => child.matches(ACTIVE)) as HTMLElement[];
      if (active.length !== 1 || !box.clientWidth || !box.clientHeight) { delete box.dataset.slide; return; }
      const el = active[0], snap = !box.hasAttribute("data-slide") || performance.now() - instantAt < 400;
      if (snap) box.dataset.slideSnap = "";
      box.style.setProperty("--sx", `${el.offsetLeft}px`);
      box.style.setProperty("--sy", `${el.offsetTop}px`);
      box.style.setProperty("--sw", String(el.offsetWidth / box.clientWidth));
      box.style.setProperty("--sh", String(el.offsetHeight / box.clientHeight));
      box.dataset.slide = "";
      if (snap) { void box.offsetWidth; delete box.dataset.slideSnap; }
    };
    const resize = new ResizeObserver(entries => { instantAt = performance.now(); entries.forEach(entry => queue(entry.target as HTMLElement)); });
    const queue = (box: HTMLElement) => {
      resize.observe(box);
      dirty.add(box);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; dirty.forEach(place); dirty.clear(); });
    };
    const scan = (root: ParentNode) => root.querySelectorAll<HTMLElement>(BOX).forEach(queue);
    const mutations = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "attributes") { const box = (record.target as Element).parentElement?.closest<HTMLElement>(BOX); if (box) queue(box); }
        else record.addedNodes.forEach(node => { if (node instanceof HTMLElement) { if (node.matches(BOX)) queue(node); scan(node); } });
      }
    });
    const keys = () => { instantAt = performance.now(); };
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-pressed", "aria-selected", "aria-current"] });
    document.addEventListener("keydown", keys, true);
    scan(document);
    return () => { mutations.disconnect(); resize.disconnect(); document.removeEventListener("keydown", keys, true); cancelAnimationFrame(frame); };
  }, []);
  return null;
}
