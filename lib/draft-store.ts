import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

const drafts = new Map<string, ChatDraft>();

// Durable layer: the in-memory Map above dies on a full page refresh, which
// loses unsent composer text. Every mutation is written through to
// localStorage under the same draft key, and reads fall back to it.
const LS_PREFIX = "pi-web:draft:";
const MAX_PERSISTED_DRAFTS = 60;
const MAX_PERSISTED_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Images are base64 blobs; persist them only when the whole draft stays well
// under the ~5MB localStorage budget so text drafts never fail to save.
const MAX_PERSISTED_IMAGE_BYTES = 1_500_000;

interface PersistedDraftEnvelope {
  v: 1;
  ts: number;
  draft: ChatDraft;
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}

function readPersistedDraft(key: string): ChatDraft | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(LS_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedDraftEnvelope | null;
    const draft = parsed?.draft;
    if (!draft
      || parsed.v !== 1
      || typeof draft.value !== "string"
      || !Array.isArray(draft.images)) {
      return null;
    }
    if (typeof parsed.ts !== "number" || Date.now() - parsed.ts > MAX_PERSISTED_AGE_MS) {
      return null;
    }
    const images = draft.images
      .filter((image): image is ChatDraftImage =>
        Boolean(image)
        && typeof image.data === "string"
        && typeof image.mimeType === "string")
      .filter(isBase64ImageWithinLimits)
      .slice(0, MAX_ATTACHED_IMAGES);
    return { value: draft.value, images };
  } catch {
    return null;
  }
}

function writePersistedDraft(key: string, draft: ChatDraft): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  const envelope: PersistedDraftEnvelope = { v: 1, ts: Date.now(), draft };
  const imageBytes = draft.images.reduce((total, image) => total + image.data.length, 0);
  if (imageBytes > MAX_PERSISTED_IMAGE_BYTES) {
    // Text survives; oversized images stay in memory only.
    envelope.draft = { value: draft.value, images: [] };
  }
  try {
    ls.setItem(LS_PREFIX + key, JSON.stringify(envelope));
  } catch {
    // Quota exceeded — retry with text only so the typed content is durable.
    try {
      ls.setItem(LS_PREFIX + key, JSON.stringify({
        v: 1,
        ts: envelope.ts,
        draft: { value: draft.value, images: [] },
      }));
    } catch {
      return;
    }
  }
  prunePersistedDrafts(ls);
}

function prunePersistedDrafts(ls: Storage): void {
  try {
    const entries: Array<{ key: string; ts: number }> = [];
    for (let i = 0; i < ls.length; i++) {
      const lsKey = ls.key(i);
      if (!lsKey || !lsKey.startsWith(LS_PREFIX)) continue;
      let ts = 0;
      try {
        ts = (JSON.parse(ls.getItem(lsKey) ?? "") as PersistedDraftEnvelope | null)?.ts ?? 0;
      } catch {
        // Malformed entry — treat as oldest so it gets pruned first.
      }
      entries.push({ key: lsKey, ts });
    }
    const now = Date.now();
    for (const entry of entries) {
      if (now - entry.ts > MAX_PERSISTED_AGE_MS) ls.removeItem(entry.key);
    }
    if (entries.length <= MAX_PERSISTED_DRAFTS) return;
    entries.sort((a, b) => b.ts - a.ts);
    for (const entry of entries.slice(MAX_PERSISTED_DRAFTS)) {
      ls.removeItem(entry.key);
    }
  } catch {
    // Pruning is best-effort.
  }
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  if (draft) return cloneDraft(draft);
  const persisted = readPersistedDraft(key);
  if (persisted) {
    if (isEmptyDraft(persisted)) {
      clearDraft(key);
      return null;
    }
    drafts.set(key, cloneDraft(persisted));
    return cloneDraft(persisted);
  }
  return null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    clearDraft(key);
    return;
  }
  drafts.set(key, cloneDraft(draft));
  writePersistedDraft(key, draft);
}

export function clearDraft(key: string): void {
  drafts.delete(key);
  const ls = safeLocalStorage();
  if (ls) {
    try {
      ls.removeItem(LS_PREFIX + key);
    } catch {
      // Ignore storage failures — clearing is best-effort.
    }
  }
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(({ data, mimeType }) => ({ data, mimeType }));

  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
  };
}

export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [] };
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    current.value,
    current.images,
  );
  setDraft(key, restored);
  return restored;
}

export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous = currentDraft && !isEmptyDraft(currentDraft)
    ? cloneDraft(currentDraft)
    : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next
    ? mergeRestoredSubmissionDraft(next.value, next.images, previous.value, previous.images)
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}
