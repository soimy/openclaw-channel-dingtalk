import type { FeedbackScope } from "./feedback-store";
type Listener = (scope: FeedbackScope, cardId: string) => void;
const listeners = new Set<Listener>();
export function onFeedbackReportPending(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** A bounded in-memory hint only. Durable recovery comes from the rating record. */
export function notifyFeedbackReportPending(scope: FeedbackScope, cardId: string): void {
  for (const listener of listeners) {
    try {
      listener(scope, cardId);
    } catch {
      /* Optional reporting cannot fail a saved vote. */
    }
  }
}

const activityListeners = new Set<(id: string, active: boolean) => void | Promise<void>>();
const backgroundReleases = new Set<Promise<void>>();
let activitySequence = 0;
export function onFeedbackForegroundActivity(
  listener: (id: string, active: boolean) => void | Promise<void>,
): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}
export function beginFeedbackForegroundActivity(): () => void {
  if (!activityListeners.size) {
    return () => {};
  }
  const id = `dingtalk-inbound:${++activitySequence}`;
  const emit = (active: boolean) => {
    for (const listener of activityListeners) {
      try {
        const release = listener(id, active);
        if (release && typeof release.then === "function") {
          backgroundReleases.add(release);
          void release.then(
            () => backgroundReleases.delete(release),
            () => backgroundReleases.delete(release),
          );
        }
      } catch {
        /* Optional reporting cannot fail input. */
      }
    }
  };
  emit(true);
  let ended = false;
  return () => {
    if (!ended) {
      ended = true;
      emit(false);
    }
  };
}
/** Foreground readers wait for background termination before allocating their own worker. */
export async function waitForFeedbackBackgroundIdle(): Promise<void> {
  await Promise.all(backgroundReleases);
}
export async function withFeedbackForegroundActivity<T>(run: () => Promise<T>): Promise<T> {
  const end = beginFeedbackForegroundActivity();
  try {
    return await run();
  } finally {
    end();
  }
}
