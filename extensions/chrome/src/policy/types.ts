// ──────────────────────────────────────────────
// Policy Contracts — site grants & hard blocks
// ──────────────────────────────────────────────

/** Severity of a policy decision. */
export type PolicyVerdict = "allow" | "deny" | "confirm";

/** Category of site being accessed. */
export type SiteCategory =
  | "general"
  | "credentials"       // login pages, password managers
  | "payments"          // checkout, banking, payment processors
  | "email"             // webmail
  | "admin"             // cloud consoles, dashboards
  | "sensitive";        // health, legal, other regulated

/** A single site grant or block. */
export interface SiteRule {
  pattern: string;      // match pattern, e.g. "*://*.bank.com/*"
  verdict: PolicyVerdict;
  category: SiteCategory;
  reason?: string;
}

/** User-configured policy overrides. */
export interface PolicyConfig {
  /** Custom allowlist (user adds sites Verboo can automate). */
  allowlist: SiteRule[];
  /** Custom blocklist (user forbids automation on these sites). */
  blocklist: SiteRule[];
}

/** Result of checking a URL against policy. */
export interface PolicyCheck {
  url: string;
  verdict: PolicyVerdict;
  matchedRule?: SiteRule;
  category: SiteCategory;
}

/** Static compile-time hard blocks — never overridable. */
export type HardBlockReason = "internal_chrome_page" | "extension_page" | "chrome_store";

// ── Tool Execution Policy ───────────────────

/** Which tools are restricted on a given site category. */
export type ToolRestriction =
  | { tool: "extract"; blocked: boolean }
  | { tool: "evaluate"; blocked: boolean }
  | { tool: "screenshot"; blocked: boolean }
  | { tool: "file_dialog"; blocked: boolean }
  | { tool: "navigate"; blocked: boolean };
