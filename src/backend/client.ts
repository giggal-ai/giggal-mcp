import { request } from "undici";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { sanitizeReason, sanitizeErrorMessage } from "./sanitize.js";
import type {
  VerifySingleResponse,
  VerifyBatchSubmitResponse,
  BatchPollResponse,
  CreditBalanceResponse,
  VerificationHistoryEntry,
  VerificationResult,
  VerificationAttributes,
} from "./types.js";

/**
 * HTTP client for the Giggal.ai backend.
 *
 * Real mode: calls /v1/* developer API endpoints with a Bearer API key
 *   from GIGGAL_API_KEY. All calls attribute to the API key's owner.
 *
 * Mock mode (BACKEND_INTERNAL_URL='mock://'): returns synthetic responses
 *   for testing without a live backend. Only usable when NODE_ENV != production.
 */

const MOCK_URL_PREFIX = "mock://";

function isMock(): boolean {
  return (
    config.NODE_ENV !== "production" &&
    config.BACKEND_INTERNAL_URL.startsWith(MOCK_URL_PREFIX)
  );
}

async function apiFetch<T>(
  method: "GET" | "POST",
  path: string,
  userId: string,
  body?: unknown
): Promise<T> {
  const url = `${config.BACKEND_INTERNAL_URL}${path}`;
  const res = await request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Service-Token": config.MCP_SERVICE_BACKEND_TOKEN,
      "X-User-ID": userId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    logger.warn({ statusCode: res.statusCode, path, text: text.slice(0, 300) }, "backend error");
    throw new BackendError(res.statusCode, text || `HTTP ${res.statusCode}`);
  }
  return JSON.parse(text) as T;
}

export class BackendError extends Error {
  constructor(public readonly statusCode: number, public readonly detail: string) {
    super(`backend HTTP ${statusCode}: ${detail}`);
    this.name = "BackendError";
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export async function verifySingle(
  userId: string,
  email: string
): Promise<VerifySingleResponse> {
  if (isMock()) return mockVerifySingle(email);

  const resp = await apiFetch<{
    success: boolean;
    data: BackendValidationResult;
    meta: { creditsUsed: number };
  }>("POST", "/v1/verify", userId, { email });

  const balance = await getCreditsFromBackend(userId);

  return {
    result: mapValidationResult(resp.data),
    credits_used: resp.meta.creditsUsed ?? 1,
    credits_remaining: balance.availableCredits,
  };
}

export async function submitBatch(
  userId: string,
  emails: string[],
  autoCatchallRescue: boolean
): Promise<VerifyBatchSubmitResponse> {
  if (isMock()) return mockSubmitBatch(emails);

  const validationFlags: Record<string, unknown> = {};
  if (autoCatchallRescue) {
    validationFlags.auto_catchall_rescue = true;
    validationFlags.autoCatchallRescue = true;
  }

  const resp = await apiFetch<{
    success: boolean;
    data: {
      jobId: string;
      totalEmails: number;
      status: string;
    };
  }>("POST", "/v1/verify-batch", userId, {
    emails,
    name: `MCP batch (${emails.length} emails)`,
    validationFlags,
  });

  return {
    batch_id: resp.data.jobId,
    total_emails: resp.data.totalEmails,
    estimated_seconds: Math.min(emails.length * 0.5, 60),
  };
}

export async function pollBatch(
  userId: string,
  batchId: string
): Promise<BatchPollResponse> {
  if (isMock()) return mockPollBatch(batchId);

  const jobResp = await apiFetch<{
    success: boolean;
    data: {
      jobId: string;
      status: string;
      progress?: { processed: number; total: number };
      totalEmails: number;
      processedEmails: number;
      error?: string | null;
    };
  }>("GET", `/v1/jobs/${encodeURIComponent(batchId)}`, userId);

  const jobStatus = jobResp.data.status;

  if (jobStatus === "failed") {
    return { status: "failed", error_message: jobResp.data.error ?? "batch failed" };
  }

  if (jobStatus !== "completed") {
    return {
      status: "processing",
      progress: jobResp.data.progress?.processed ?? jobResp.data.processedEmails ?? 0,
      total: jobResp.data.progress?.total ?? jobResp.data.totalEmails ?? 0,
    };
  }

  const results = await fetchAllJobResults(userId, batchId, 1000);
  const balance = await getCreditsFromBackend(userId);
  // Catch-all rescue is always ON for MCP batches, so every email costs
  // 1.5 credits. Backend floors the total; we mirror that here so the
  // number we display in chat matches the ledger entry the user sees.
  return {
    status: "completed",
    results,
    credits_used: Math.floor(results.length * 1.5),
    credits_remaining: balance.availableCredits,
  };
}

export async function getCreditBalance(
  userId: string
): Promise<CreditBalanceResponse> {
  if (isMock()) return mockCreditBalance();

  const b = await getCreditsFromBackend(userId);
  return {
    credits_remaining: b.availableCredits,
    plan: "Giggal.ai",
    plan_credits_per_month: null,
    next_refresh_date: null,
  };
}

export async function getVerificationHistoryEntry(
  _userId: string,
  email: string
): Promise<VerificationHistoryEntry | null> {
  // The developer API doesn't expose a per-email history endpoint. For now,
  // return null (tool response guides the user to run verify_emails instead).
  if (isMock()) return mockHistoryEntry(email);
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

interface BackendCreditsResponse {
  balance: number;
  availableCredits: number;
  reservedCredits: number;
  totalPurchased: number;
  totalConsumed: number;
}

async function getCreditsFromBackend(userId: string): Promise<BackendCreditsResponse> {
  const r = await apiFetch<{ success: boolean; data: BackendCreditsResponse }>(
    "GET",
    "/v1/credits",
    userId
  );
  return r.data;
}

interface BackendValidationResult {
  email: string;
  is_valid: boolean;
  status: string;
  deliverability_score?: number;
  details?: {
    general?: { domain?: string; reason?: string; validation_method?: string };
    attributes?: Partial<VerificationAttributes>;
    mail_server?: { smtp_provider?: string | null; mx_record?: string | null };
  };
}

function mapValidationResult(d: BackendValidationResult): VerificationResult {
  const attrs = d.details?.attributes ?? {};
  const catchAll = attrs.catch_all ?? false;
  const status = normalizeStatus(d.status);
  // Every reason string that crosses the MCP boundary goes through the
  // sanitizer. This is the choke point that keeps raw SMTP codes, provider-
  // specific greeting text (gsmtp IDs etc.), catch-all method phrasing, and
  // support URLs out of anything the caller — human or LLM — can observe.
  const safeReason = sanitizeReason(d.details?.general?.reason, status);
  return {
    email: d.email,
    status,
    score: d.deliverability_score ?? (d.is_valid ? 90 : 10),
    catch_all_domain: catchAll,
    attributes: {
      free_email: attrs.free_email ?? false,
      role_account: attrs.role_account ?? false,
      disposable: attrs.disposable ?? false,
      catch_all: catchAll,
      mailbox_full: attrs.mailbox_full ?? false,
      no_reply: attrs.no_reply ?? false,
    },
    reason: safeReason,
    // mx_provider and mx_record are DNS-observable information, but we still
    // omit them from the MCP surface: keeping them would let a caller
    // fingerprint how we classify providers, and they're not required for
    // the "is this email good to send?" question the tool answers.
    mx_provider: null,
    mx_record: null,
  };
}

function normalizeStatus(s: string): VerificationResult["status"] {
  const v = s.toLowerCase();
  if (v === "deliverable" || v === "undeliverable" || v === "unknown" || v === "risky") {
    return v;
  }
  return "unknown";
}

async function fetchAllJobResults(
  userId: string,
  jobId: string,
  cap: number
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  let page = 1;
  const limit = 200;
  while (results.length < cap) {
    const r = await apiFetch<{
      success: boolean;
      data: {
        results: BackendValidationResult[];
        pagination?: { page: number; limit: number; total: number; hasNextPage?: boolean };
      };
    }>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/results?page=${page}&limit=${limit}`, userId);
    for (const raw of r.data.results ?? []) {
      results.push(mapValidationResult(raw));
      if (results.length >= cap) break;
    }
    const p = r.data.pagination;
    if (!p || !p.hasNextPage || results.length >= (p.total ?? 0)) break;
    page += 1;
  }
  return results;
}

// ── Mock implementations (dev only) ────────────────────────────────────────

function fakeResult(email: string): VerificationResult {
  const isKnownBad = email.startsWith("bad@") || email.includes("+invalid");
  const isFree = /@(gmail|yahoo|outlook|hotmail|icloud)\.com$/i.test(email);
  return {
    email,
    status: isKnownBad ? "undeliverable" : "deliverable",
    score: isKnownBad ? 5 : 95,
    catch_all_domain: false,
    attributes: {
      free_email: isFree,
      role_account: /^(info|admin|support|hello)@/i.test(email),
      disposable: false,
      catch_all: false,
      mailbox_full: false,
      no_reply: /^no.?reply@/i.test(email),
    },
    reason: isKnownBad ? "Mailbox does not exist (mock)" : "SMTP OK (mock)",
    mx_provider: isFree ? "google" : null,
  };
}

function mockVerifySingle(email: string): VerifySingleResponse {
  return { result: fakeResult(email), credits_used: 1, credits_remaining: 4999 };
}

const mockBatches = new Map<string, { emails: string[]; polls: number }>();

function mockSubmitBatch(emails: string[]): VerifyBatchSubmitResponse {
  const batchId = `mock_batch_${Math.random().toString(36).slice(2, 10)}`;
  mockBatches.set(batchId, { emails, polls: 0 });
  return {
    batch_id: batchId,
    total_emails: emails.length,
    estimated_seconds: Math.min(emails.length * 0.3, 30),
  };
}

function mockPollBatch(batchId: string): BatchPollResponse {
  const entry = mockBatches.get(batchId);
  if (!entry) return { status: "failed", error_message: "batch not found" };
  entry.polls += 1;
  if (entry.polls < 2) {
    return {
      status: "processing",
      progress: Math.floor(entry.emails.length / 2),
      total: entry.emails.length,
    };
  }
  const results = entry.emails.map(fakeResult);
  mockBatches.delete(batchId);
  return {
    status: "completed",
    results,
    credits_used: results.length,
    credits_remaining: 5000 - results.length,
  };
}

function mockCreditBalance(): CreditBalanceResponse {
  return {
    credits_remaining: 4999,
    plan: "Growth (mock)",
    plan_credits_per_month: 10000,
    next_refresh_date: "2026-08-01T00:00:00Z",
  };
}

function mockHistoryEntry(email: string): VerificationHistoryEntry | null {
  if (email.includes("nohistory")) return null;
  return {
    email,
    result: fakeResult(email),
    verified_at: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
  };
}
