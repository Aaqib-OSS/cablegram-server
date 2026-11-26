export interface SentryBreadcrumbLike {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface SentryScrubTarget {
  request?: {
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
    query_string?: string | Record<string, string>;
    data?: unknown;
  };
  extra?: Record<string, unknown>;
  breadcrumbs?: SentryBreadcrumbLike[];
}

interface SentryClientLike {
  init(options: {
    dsn: string;
    environment: string;
    release: string;
    sendDefaultPii: boolean;
    beforeSend: (event: SentryScrubTarget) => SentryScrubTarget | null;
    beforeBreadcrumb: (breadcrumb: SentryBreadcrumbLike) => SentryBreadcrumbLike | null;
  }): void;
  captureException(error: unknown, context?: { extra?: Record<string, unknown> }): void;
}

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-admin-key",
  "x-test-mail-key",
  "x-gateway-secret",
  "proxy-authorization",
]);

const SENSITIVE_QUERY_PARAMS = ["token", "secret", "auth", "key", "password", "code", "credential"];

export function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url, "http://localhost");
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMS.some((p) => key.toLowerCase().includes(p))) {
        parsed.searchParams.set(key, "REDACTED");
      }
    }
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return parsed.toString();
    }
    return parsed.pathname + parsed.search;
  } catch {
    return url.replace(/([?&](?:token|code|secret|password)=)[^&]+/gi, "$1REDACTED");
  }
}

export function scrubHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const scrubbed: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
      scrubbed[k] = "[REDACTED]";
    } else {
      scrubbed[k] = v;
    }
  }
  return scrubbed;
}

export function scrubEvent<T extends SentryScrubTarget>(event: T): T {
  if (event.request) {
    if (event.request.url) {
      event.request.url = scrubUrl(event.request.url);
    }
    if (event.request.headers) {
      event.request.headers = scrubHeaders(event.request.headers);
    }
    if (event.request.data !== undefined) {
      delete event.request.data;
    }
    if (typeof event.request.query_string === "string") {
      event.request.query_string = scrubUrl(event.request.query_string);
    }
  }
  if (event.breadcrumbs) {
    for (const b of event.breadcrumbs) {
      if (b.message) {
        b.message = scrubUrl(b.message);
      }
      if (b.data?.url && typeof b.data.url === "string") {
        b.data.url = scrubUrl(b.data.url);
      }
    }
  }
  return event;
}

let sentryClient: unknown = null;

export async function initSentry(options?: { dsn?: string; environment?: string; release?: string }): Promise<void> {
  const dsn = options?.dsn ?? process.env.SENTRY_DSN ?? process.env.SENTRY_DSN_SERVER;
  if (!dsn) return;
  try {
    // @ts-expect-error - @sentry/node is an optional runtime dependency
    const Sentry = (await import("@sentry/node")) as unknown as SentryClientLike;
    Sentry.init({
      dsn,
      environment: options?.environment ?? process.env.NODE_ENV ?? "development",
      release: options?.release ?? process.env.CABLEGRAM_VERSION ?? "0.1.0",
      sendDefaultPii: false,
      beforeSend(event: SentryScrubTarget) {
        return scrubEvent(event);
      },
      beforeBreadcrumb(breadcrumb: SentryBreadcrumbLike) {
        if (breadcrumb.data?.url && typeof breadcrumb.data.url === "string") {
          breadcrumb.data.url = scrubUrl(breadcrumb.data.url);
        }
        return breadcrumb;
      },
    });
    sentryClient = Sentry;
  } catch {
    // When @sentry/node is not installed or available, safely no-op
  }
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!sentryClient) return;
  try {
    const Sentry = sentryClient as { captureException: (err: unknown, ctx?: { extra?: Record<string, unknown> }) => void };
    Sentry.captureException(error, context ? { extra: context } : undefined);
  } catch {
    // A failed capture must never break the request
  }
}
