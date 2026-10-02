# dashboard (placeholder)

Owner dashboard, built in a later session: one-tap approvals, kill switch, audit viewer, backtest results.

It will talk to the proxy's owner API (all of it already exists and is tested):

| Endpoint | Purpose |
| --- | --- |
| `GET /approvals?status=pending` | inbox of held calls (tool, arguments, reasons, explanation) |
| `POST /approvals/:id` `{"decision":"approve"\|"deny"}` | approve (mints a single-use step-up mandate and executes) or deny |
| `POST /freeze`, `POST /unfreeze` `{"agentId"?, "reason"?}` | kill switch, global or per agent |
| `GET /audit/verify[?head=<hash>]` | recompute the audit hash chain |

All owner endpoints need `Authorization: Bearer $PAYLEASH_OWNER_TOKEN`.
