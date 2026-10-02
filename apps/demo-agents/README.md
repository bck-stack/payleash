# demo-agents (placeholder)

Demo agents for the hackathon demo, built in a later session: a support agent that reads customer emails and issues
refunds, and a billing agent that sends invoices, both connected to the PayLeash proxy.

Contract they will rely on (already implemented in `packages/proxy`):

* connect over streamable HTTP with `Authorization: Bearer <mandate>`;
* call `payleash_register_untrusted(sourceId, text)` for every inbound email / ticket **before** acting on it;
* a write tool may return `{"status":"pending_approval","approvalId":...}`; poll `payleash_check_approval(approvalId)`;
* use `scripts/seed-sandbox/fixtures/backtest-history.json` and `disputes.json` for data without sandbox credentials.
