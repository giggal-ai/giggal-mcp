/**
 * Public-API client for the self-hostable server.
 *
 * Talks to the public Giggal.ai Developer API (https://api.giggal.ai/v1) with
 * the caller's own `Authorization: Bearer <key>`. The routes and response
 * shapes are identical to the ones the hosted server uses internally, so the
 * mapping logic here mirrors src/backend/client.ts — the only differences are
 * the base URL, the auth header, and the absence of a per-request user id
 * (the API key identifies the account).
 */
import { request } from "undici";
import { localConfig, requireApiKey } from "./config.js";
import { sanitizeReason } from "../backend/sanitize.js";
import type {
  VerifySingleResponse,
  VerifyBatchSubmitResponse,
  BatchPollResponse,
  CreditBalanceResponse,
  VerificationResult,
  VerificationAttributes,
} from "../backend/types.js";

export class PublicApiError extends Error {
  constructor(public readonly statusCode: number, public readonly detail: string) {
    super(`Giggal API HTTP ${statusCode}: ${detail}`);
    this.name = "PublicApiError";
  }
}

async function apiFetch<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const apiKey = requireApiKey();
  const url = `${localConfig.apiBase}${path}`;
  const res = await request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new PublicApiError(res.statusCode, extractError(text) || `HTTP ${res.statusCode}`);
  }
  return JSON.parse(text) as T;
}

function extractError(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: string; message?: string };
    return j.error || j.message || "";
  } catch {
    return text.slice(0, 300);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function verifySingle(email: string): Promise<VerifySingleResponse> {
  const resp = await apiFetch<{
    success: boolean;
    data: BackendValidationResult;
    meta?: { creditsUsed?: number };
  }>("POST", "/verify", { email });

  const balance = await getCredits();

  return {
    result: mapValidationResult(resp.data),
    credits_used: resp.meta?.creditsUsed ?? 1,
    credits_remaining: balance.availableCredits,
  };
}

export async function submitBatch(
  emails: string[],
  autoCatchallRescue: boolean
): Promise<VerifyBatchSubmitResponse> {
  const validationFlags: Record<string, unknown> = {};
  if (autoCatchallRescue) {
    validationFlags.auto_catchall_rescue = true;
    validationFlags.autoCatchallRescue = true;
  }

  const resp = await apiFetch<{
    success: boolean;
    data: { jobId: string; totalEmails: number; status: string };
  }>("POST", "/verify-batch", {
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

export async function pollBatch(batchId: string): Promise<BatchPollResponse> {
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
  }>("GET", `/jobs/${encodeURIComponent(batchId)}`);

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

  const results = await fetchAllJobResults(batchId, 1000);
  const balance = await getCredits();
  // Catch-all rescue is always ON for MCP batches, so every email costs
  // 1.5 credits; the backend floors the total, mirrored here.
  return {
    status: "completed",
    results,
    credits_used: Math.floor(results.length * 1.5),
    credits_remaining: balance.availableCredits,
  };
}

export async function getCreditBalance(): Promise<CreditBalanceResponse> {
  const b = await getCredits();
  return {
    credits_remaining: b.availableCredits,
    plan: "Giggal.ai",
    plan_credits_per_month: null,
    next_refresh_date: null,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getCredits(): Promise<{ availableCredits: number }> {
  const r = await apiFetch<{ success: boolean; data: { availableCredits: number } }>(
    "GET",
    "/credits"
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
  // Every reason string that crosses the tool boundary goes through the
  // sanitizer, the same choke point the hosted server uses.
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

async function fetchAllJobResults(jobId: string, cap: number): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  let page = 1;
  const limit = 200;
  while (results.length < cap) {
    const r = await apiFetch<{
      success: boolean;
      data: {
        results: BackendValidationResult[];
        pagination?: { page: number; limit: number; total: number; pages: number };
      };
    }>("GET", `/jobs/${encodeURIComponent(jobId)}/results?page=${page}&limit=${limit}`);
    for (const raw of r.data.results ?? []) {
      results.push(mapValidationResult(raw));
      if (results.length >= cap) break;
    }
    const p = r.data.pagination;
    if (!p) break;
    if (page >= (p.pages ?? 1)) break;
    if (results.length >= (p.total ?? 0)) break;
    page += 1;
  }
  return results;
}
