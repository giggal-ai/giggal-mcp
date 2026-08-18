/**
 * Shapes returned by backend/internal/* endpoints.
 * Kept intentionally minimal — mirror only what MCP tools actually need.
 */

export type VerificationStatus = "deliverable" | "undeliverable" | "unknown" | "risky";

export interface VerificationAttributes {
  free_email: boolean;
  role_account: boolean;
  disposable: boolean;
  catch_all: boolean;
  mailbox_full: boolean;
  no_reply: boolean;
}

export interface VerificationResult {
  email: string;
  status: VerificationStatus;
  score: number; // 0-100
  /**
   * Top-level convenience field mirroring `attributes.catch_all`. Kept as a
   * first-class property on each result so the MCP outputSchema can declare
   * it as required — this is what lets clients render a "Catch-all Domain"
   * column reliably instead of burying the flag inside a nested object.
   */
  catch_all_domain: boolean;
  attributes: VerificationAttributes;
  reason: string;
  mx_provider?: string | null;
  mx_record?: string | null;
}

/** Sync single-email verify response. */
export interface VerifySingleResponse {
  result: VerificationResult;
  credits_used: number;
  credits_remaining: number;
}

/** Async batch submission response. */
export interface VerifyBatchSubmitResponse {
  batch_id: string;
  total_emails: number;
  estimated_seconds: number;
}

/** Poll response — status either processing or completed. */
export type BatchPollResponse =
  | {
      status: "processing";
      progress: number;
      total: number;
    }
  | {
      status: "completed";
      results: VerificationResult[];
      credits_used: number;
      credits_remaining: number;
    }
  | {
      status: "failed";
      error_message: string;
    };

export interface CreditBalanceResponse {
  credits_remaining: number;
  plan: string;
  plan_credits_per_month: number | null;
  next_refresh_date: string | null; // ISO-8601 or null
}

export interface VerificationHistoryEntry {
  email: string;
  result: VerificationResult;
  verified_at: string; // ISO-8601
}
