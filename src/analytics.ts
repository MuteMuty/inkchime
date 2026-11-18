// Usage events (lab#71) go through the lab's shared analytics script, which the hub serves. It's added
// only once the page has loaded and gone idle, so drawing and sound never wait for it; if it's blocked or
// fails, queued events are simply never sent. On localhost and *.workers.dev previews, and for visitors who
// ask sites not to track them (Do Not Track or Global Privacy Control), the script isn't even fetched.
// The rules it applies (including addresses sent without their # and ?, where a song link keeps the
// drawing), and the lab-wide event names, live in the hub (hub/web/analytics/guard.ts).
// What Inkchime may send is in analytics-events.ts. Kept free of the DOM until loadAnalytics() runs,
// so tests/unit/analytics.test.ts can run it in Node.

export type Value = string | number | boolean;
/** Event name → the properties it may carry → each property's allowed values (enums or bucket labels). */
export type AllowList = Readonly<Record<string, Readonly<Record<string, readonly Value[]>>>>;
export type Props = Record<string, Value>;
type Config = { project: string; allow: AllowList; queue: { push(...events: [string, Props?][]): unknown } };

declare global {
  interface Window { labAnalytics?: Config; doNotTrack?: string | null } // window.doNotTrack: older Safari and Edge
  interface Navigator { globalPrivacyControl?: boolean }
}

export const SCRIPT = "https://lab.brightloopapps.com/analytics/v1.js";

/** Lab pages in production. Everything else (localhost, *.workers.dev previews, tests, playtests) sends nothing. */
export const isProduction = (hostname: string) => hostname.endsWith(".brightloopapps.com");

/** Do Not Track (either spelling) or Global Privacy Control is on. The lab's privacy note promises nothing is sent then. */
export const optedOut = (nav: { doNotTrack?: string | null; globalPrivacyControl?: boolean }, win: { doNotTrack?: string | null }) =>
  nav.doNotTrack === "1" || nav.doNotTrack === "yes" || win.doNotTrack === "1" || nav.globalPrivacyControl === true;

/** Whether to fetch the shared script at all. */
export const shouldLoad = (hostname: string, nav: Parameters<typeof optedOut>[0], win: Parameters<typeof optedOut>[1]) =>
  isProduction(hostname) && !optedOut(nav, win);

/** Set up the queue and add the shared script once the page is idle. Does nothing where nothing may be sent. */
export function loadAnalytics(project: string, allow: AllowList) {
  if (window.labAnalytics || !shouldLoad(location.hostname, navigator, window)) return;
  window.labAnalytics = { project, allow, queue: [] };
  const add = () => document.head.append(Object.assign(document.createElement("script"), { src: SCRIPT, async: true }));
  const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(add, { timeout: 3000 }) : setTimeout(add, 200));
  if (document.readyState === "complete") idle();
  else addEventListener("load", idle, { once: true });
}

/** Queue an event for the shared script. Without loadAnalytics() having set up the queue, it does nothing. */
export const track = (name: string, props?: Props) => { window.labAnalytics?.queue.push([name, props]); };
