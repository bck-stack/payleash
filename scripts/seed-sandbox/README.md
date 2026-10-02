# seed-sandbox

Creates demo data in your **PayPal sandbox** for the PayLeash demo and for the backtest. Sandbox only: it refuses any
non-sandbox `PAYPAL_BASE_URL` and has no override flag.

```bash
export PAYPAL_CLIENT_ID=...        # sandbox REST app (developer.paypal.com -> Apps & Credentials -> Sandbox)
export PAYPAL_CLIENT_SECRET=...
pnpm install && pnpm build         # once: the script uses @payleash/core
pnpm seed -- --count 5             # start small: 5 orders
pnpm seed                          # the full run (200 orders)
pnpm seed -- --dry-run             # print the plan, call nothing
pnpm seed -- --history             # regenerate the offline fixtures (no credentials needed)
```

Without credentials it prints what to set and **exits 0**, so CI never fails because secrets are absent.

## What it creates

| What | How | Notes |
| --- | --- | --- |
| 4 products | `POST /v1/catalogs/products` with `id` = SKU | duplicate id means "already there" |
| ~200 captured orders | `POST /v2/checkout/orders` then `POST /v2/checkout/orders/{id}/capture` | see "Orders" below |
| 6 partial refunds | `POST /v2/payments/captures/{id}/refund` with an `amount` | 25% / 50% of the order, rounded |
| 5 invoices | `POST /v2/invoicing/invoices`, 2 of them sent | amounts 60 / 120 / 450 / 75.50 / 1200 |
| disputes | **not creatable**, it only lists existing ones | see "Disputes" below |

## Idempotent and resumable

* Every create call carries a deterministic `PayPal-Request-Id` (`payleash-seed-order-0007`, ...), so PayPal itself
  de-duplicates a retried request.
* Progress is stored in `scripts/seed-sandbox/.seed-state/state.json` (gitignored). A re-run skips everything that is
  done, picks up where an interrupted run stopped, and creates only the missing orders if you raise `--count`.
* `seed-output/manifest.json` (gitignored) lists every id that was created, with the **real payer email PayPal reports**
  (not the plan's persona): use it to choose capture ids for the smoke test.

## Orders: the one manual step you may have to do

A PayPal-wallet order needs a human buyer to approve it, which an API cannot do. The script therefore tries, in order:

1. **Card orders** (`--mode card`, the first thing `auto` tries): `payment_source.card` with a sandbox test card, captured
   straight away. This works when your sandbox business account can take direct card payments.
   The script probes with the first order; if PayPal rejects it, the choice is remembered in the state file.
2. **PayPal-wallet orders** (`--mode paypal`, or the automatic fallback): the script creates `--paypal-orders` (default 10)
   orders and prints an approve link for each. **Open each link, log in with a sandbox *personal* (buyer) account, approve.**
   Then run `pnpm seed` again: approved orders are captured and the rest (refunds, invoices) continues.
   Use two or three different buyer accounts to get the "2-3 buyers" the demo wants.

Ten orders is enough for the smoke test in `docs/SMOKE-TEST.md`. For two hundred orders use card mode.

## The 90-day history cannot come from the sandbox

PayPal stamps orders with the time they are created; the sandbox cannot backdate them. So the 200 live orders all carry
today's date. For the backtest, `--history` writes a **deterministic offline history** in the real API shapes:

* `fixtures/backtest-history.json`: 200 orders from 3 buyers spread over 90 days, 8 with partial refunds.
* `fixtures/disputes.json`: 3 disputes (one buyer message carries a prompt-injection attempt).

They expand into raw Orders v2 / Payments v2 / Disputes v1 responses with `expandOrderFixtures()` from `@payleash/core`,
so the backtest replays them through exactly the same reader and rules as live data. A test fails if the committed files
drift from the generator.

## Disputes

PayPal offers no sandbox API to open a dispute. To get real ones: log in to sandbox.paypal.com as a buyer, open
Resolution Center, and report a problem on one of the seeded orders. `pnpm seed` will list them in the manifest.
Otherwise use `fixtures/disputes.json`.

## Not verified against the live sandbox

This session had no sandbox credentials, so the request bodies follow the public API docs and are exercised only against
an in-memory fake (`test/seed.test.ts`). Most likely to need a tweak on first contact: the card `payment_source`
(depends on your sandbox account's capabilities), the invoice `send` body, and the product `category` values.
