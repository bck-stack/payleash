# Security model: what PayLeash covers, and what it does not

PayLeash sits between an AI agent and PayPal's Agent Toolkit. This page says exactly which threats it stops, how, and which it does **not**
stop. Sandbox only. Where a test proves a claim, the test is named.

## Trust boundaries

| Party | Trusted? | Why |
| --- | --- | --- |
| The owner (holds the Ed25519 owner key and the owner token) | yes | signs mandates, approves held calls, presses the kill switch |
| PayPal's own records (read with the sandbox credentials) | yes, as ground truth | amounts, ids, payers and balances are checked against it |
| The agent and the language model behind it | **no** | it may be wrong, tricked or hostile; it holds a mandate, not money-moving power |
| Any text the agent read (emails, tickets, web pages, dispute messages) | **no** | untrusted data, never instructions |
| The proxy process and its host | yes | it enforces everything; if it is compromised, nothing here helps |

## Threats covered

| # | Threat | How it is stopped | Where |
| --- | --- | --- | --- |
| 1 | **Prompt injection** makes the agent call a money tool with attacker-chosen values ("refund $999 to attacker@…") | Decisions are made by deterministic code, not by a model. Critical arguments (amount, currency, payee, capture / order / invoice / dispute / subscription id, invoice recipients) are checked against PayPal and marked `verified`, `tainted` (only in untrusted text) or `unknown`. A payee that is not the original buyer, an amount above what is left to refund, an unknown id are **denied**; a tainted or unconfirmed value is **held**. Matching survives full-width digits, zero-width characters, `[at]`/`[dot]` emails and number words. | `core/taint`, `core/test/taint.test.ts`, `demo-agents` (email 04) |
| 2 | **Over-spending**: a loop, a bug or a model that keeps refunding | Per-operation maximum, rolling 24 h total (SQLite ledger), auto-approve threshold, currency, order-age window. Amounts above the threshold wait for a human. | `core/policy`, `policy.test.ts` |
| 3 | **Double refund / duplicate request** | A refund larger than captured minus already refunded is denied; a fully refunded capture is not refundable. | `refund_exceeds_balance`, `capture_not_refundable`, demo email 05 |
| 4 | **Forged, edited, expired or wrong-key authority** | The agent's credential is an Ed25519-signed mandate (JWS) with scope, limits and expiry. A bad signature, an expired one, or one signed by another key gets no session. | `core/mandate`, `mandate.test.ts` |
| 5 | **Approval abuse**: reusing or changing an approval | Approval mints a **step-up mandate** bound to the SHA-256 of that one call (tool + canonical arguments), valid 60 s, consumed on first use. Changing one character, replaying it, or presenting it as an operation mandate fails. An approval never overrides a hard rule that changed since the hold (frozen, balance, expiry). | `core/mandate`, `guard.test.ts` |
| 6 | **Runaway agent**: something looks wrong right now | Global or per-agent kill switch: every write tool is denied immediately, reads keep working. | `policy`, demo, `owner-api.test.ts`, e2e kill switch |
| 7 | **Tampering with the record after the fact** | Hash-chained audit log in SQLite; UPDATE / DELETE are refused by triggers, and `audit verify` recomputes the chain and catches edits, deletions and insertions. Recording the head elsewhere also catches a cut tail. | `core/audit`, `audit.test.ts`, the Audit page badge |
| 8 | **A new toolkit tool nobody reviewed** | Every toolkit tool is classified read / write in `classification.ts`; an unclassified tool is **not exposed**, and a test fails until someone classifies it. | `classification.test.ts` |
| 9 | **PayPal unreachable or confused** | Fail closed: if ground truth cannot be read, the call is denied or held, never allowed. | `ground_truth_unavailable` |
| 10 | **Reaching real money**: a mistake points the proxy at live PayPal | The proxy refuses any PayPal host except the sandbox (and localhost mocks) unless `--i-know-this-is-live` is passed. The hosted demo ignores PayPal credentials, refuses a non-sandbox URL and blocks every outgoing request to a PayPal host. | `assertSandboxBaseUrl`, `blockPayPalEgress`, `demo-hosting.test.ts` |
| 11 | **Dashboard attacks**: stolen cookie, CSRF, brute force | The login sets a signed, expiring, httpOnly, SameSite=Strict cookie that never contains the owner token; cross-origin writes are refused; failed logins are throttled; strict CSP and security headers. The read-only demo role cannot freeze, sign mandates or read live data. | `sessions.ts`, `owner-api.test.ts` |
| 12 | **The explainer model leaking into decisions** | The optional language model writes one sentence after the decision. The structured reasons stay authoritative; with no model a template is used. | `explain.ts` |
| 13 | **Secrets in the repository** | Keys must live outside a git checkout (`keys init` refuses otherwise); `.env`, `*.pem` and databases are git-ignored; the hosted demo uses throw-away keys. | `keys.ts`, `.gitignore` |

## Threats NOT covered (read this part)

1. **Provenance registration is cooperative.** The agent harness must call `payleash_register_untrusted` for every email / ticket / page. (The demo agents' harness does it before the model sees the text; dispute messages read through the proxy are registered automatically.) An agent that skips it loses the "tainted" signal. It still cannot beat the mandate limits or the ground-truth rules (threat 1's denials and holds on PayPal's own records), but a *plausible* value that PayPal also confirms is accepted.
2. **A wrong but plausible request inside the limits.** If the customer is lying about a damaged mug and asks for $19, PayPal's records confirm $19 and the mandate allows it, so it runs. PayLeash bounds the damage; it does not judge whether the claim is true.
3. **A compromised proxy host, owner key or owner token.** Whoever holds them is the owner. There is no hardware-key signing, no multi-party approval, and no mandate revocation list (freeze the agent or let the mandate expire).
4. **A compromised or malicious owner device.** One tap approves. PayLeash shows what the call does and where each value came from; it cannot make a person read it.
5. **Reads are not gated.** Read tools pass through, so an agent can read order and payer data its mandate lets it call. Mandates scope write tools and amounts, not data exposure.
6. **Evidence content.** `provide_dispute_evidence` is held for the owner by default, but what the evidence says is the agent's text; the owner reads it before approving. The tool is PayLeash's own (the toolkit has none) and posts to PayPal's Disputes API as documented; it is verified against recorded responses, not yet against a live sandbox dispute.
7. **Number words and emails in other languages.** Matching of amounts in prose is English only; other languages fall back to "unknown", which is held or limited by the mandate.
8. **Availability.** One node, one SQLite file, no HA. The hosted demo sleeps on the free tier and resets nightly by design.
9. **Network exposure.** The proxy speaks plain HTTP on `127.0.0.1`; put TLS in front before exposing it (Render does). Login throttling is per client address, not per account; there is no per-user model.
10. **The explanation model sees decision facts** (including email text) of held and denied calls when it is configured. Leave it unconfigured if that is not acceptable.
11. **Live money.** Nothing here has been run against live PayPal and the proxy is built to refuse it. It is a sandbox hackathon project, not a production payment control.
