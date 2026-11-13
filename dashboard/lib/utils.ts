import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Browser tests ("UI") and k6 load-test checks ("K6") are tests, not requests: no curl, no timing. */
export function isTestStep(method?: string | null) {
  return method === "UI" || method === "K6";
}

/**
 * A step shows the Expected/Actual test view only when it carries no request or response of
 * its own. Steps with a body (the portal batch step, recorded requests) always show the
 * document, EPCs, event IDs and response.
 */
export function showsTestDetail(v?: {
  method?: string | null;
  requestBody?: string | null;
  responseBody?: string | null;
  documentPath?: string | null;
} | null) {
  return isTestStep(v?.method) && !v?.requestBody && !v?.responseBody && !v?.documentPath;
}
