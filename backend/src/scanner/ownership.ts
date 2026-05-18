/**
 * ownership.ts
 * Reads data-component, data-owner, data-source from DOM elements
 * and bubbles up to ancestors. Attaches metadata to issues.
 */

import type { Page } from "playwright";

export interface OwnershipOptions {
  dsPrefix?: string;
  maxPerIssue?: number;
}

export async function enrichOwnership(
  page: Page,
  issues: any[],
  options: OwnershipOptions = {}
): Promise<void> {
  const { dsPrefix = "", maxPerIssue = 3 } = options;

  const probe: { sel: string; idx: number }[] = [];
  issues.forEach((iss, idx) => {
    const list: string[] = Array.isArray(iss.selectors)
      ? iss.selectors
      : iss.selector ? [iss.selector] : [];
    for (const s of list.slice(0, maxPerIssue)) {
      probe.push({ sel: s, idx });
    }
  });

  if (!probe.length) return;

  const results = await page.evaluate(({ probe, dsPrefix }: any) => {
    const out: Record<number, { componentId?: string; componentOwner?: string; sourceHint?: string }> = {};
    const seen = new Set<number>();

    for (const p of probe) {
      if (seen.has(p.idx)) continue;
      let el: Element | null = null;
      try { el = document.querySelector(p.sel); } catch { el = null; }
      if (!el) continue;

      const get = (k: string) => (el as HTMLElement).getAttribute?.(k) || "";
      let componentId   = get("data-component");
      let componentOwner = get("data-owner");
      let sourceHint    = get("data-source") || get("data-file");

      let cur: Element | null = el;
      while (cur && (!componentId || !componentOwner || !sourceHint)) {
        try {
          componentId    = componentId    || (cur as HTMLElement).getAttribute?.("data-component") || "";
          componentOwner = componentOwner || (cur as HTMLElement).getAttribute?.("data-owner") || "";
          sourceHint     = sourceHint     || (cur as HTMLElement).getAttribute?.("data-source")
                                           || (cur as HTMLElement).getAttribute?.("data-file") || "";
        } catch {}
        cur = cur.parentElement;
      }

      if (!componentId && dsPrefix) {
        try {
          const cls = (el.getAttribute("class") || "").split(/\s+/).find(c => c.startsWith(dsPrefix));
          if (cls) componentId = cls;
        } catch {}
      }

      out[p.idx] = {
        componentId:    componentId    || undefined,
        componentOwner: componentOwner || undefined,
        sourceHint:     sourceHint     || undefined,
      };
      seen.add(p.idx);
    }
    return out;
  }, { probe, dsPrefix });

  Object.entries(results).forEach(([idx, o]: [string, any]) => {
    const i = Number(idx);
    if (!issues[i]) return;
    issues[i].componentId    = issues[i].componentId    || o.componentId;
    issues[i].componentOwner = issues[i].componentOwner || o.componentOwner;
    issues[i].sourceHint     = issues[i].sourceHint     || o.sourceHint;
  });
}
