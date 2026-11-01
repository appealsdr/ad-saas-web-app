# Stripe 50/50 Deposit Payment — Design & Implementation Plan

**Status:** Planned (targeting next week)
**Model chosen:** _Deposit_ — charge **50% at checkout**, **50% later** against the same saved card (one customer, two charges over time).
**Owner:** @andreiPruzan

> Rejected alternatives: (a) Connect/marketplace split between two parties, (b) two payment methods for one order. This plan is the deposit model only.

---

## The core idea

Stripe has no built-in "50/50" primitive. We do it with **two `PaymentIntent`s against one saved card**:

1. **Charge 1 (deposit)** at checkout for 50%, and *save the card* to a Stripe **Customer**.
2. **Charge 2 (balance)** later for the other 50%, **off-session** (no customer present) using that saved card.

New infrastructure required: a Stripe Customer per user, a saved payment method, and somewhere to track "balance still owed."

---

## Current flow (baseline)

Single server-priced `PaymentIntent` for the full amount:

- `POST /api/checkout/payment_intent` re-prices server-side → creates one PI for `totalCents`
  → [`payment_intent/+server.ts`](src/routes/api/checkout/payment_intent/+server.ts)
- Embedded Payment Element confirms → Stripe redirects to `/checkout/success`
- `/checkout/success` reconciles a `service_contracts` row (keyed on `stripe_payment_intent_id`) + line items + Salesforce push
  → [`checkout/success/+page.server.ts`](src/routes/checkout/success/+page.server.ts)
- Stripe SDK singleton → [`stripe.ts`](src/lib/server/stripe.ts)

---

## Step 1 — Split the amount (integer-safe)

In [`payment_intent/+server.ts`](src/routes/api/checkout/payment_intent/+server.ts), after `totalCents` is computed:

```ts
const depositCents = Math.round(totalCents / 2);
const balanceCents = totalCents - depositCents; // subtraction guarantees the two sum to the exact total
```

Using subtraction for the balance avoids losing/gaining a cent on odd totals (e.g. `$3.01` → 151 + 150).

## Step 2 — Charge 1: deposit + save the card

Need a **Stripe Customer** so the card can be reused. Look up / create it for `locals.user`, persist `stripe_customer_id` (new column on `users`), then create the deposit PI:

```ts
const intent = await getStripe().paymentIntents.create({
  amount: depositCents,              // was totalCents
  currency,
  customer: stripeCustomerId,        // NEW — required to save the card
  setup_future_usage: 'off_session', // NEW — save the card for a later off-session charge
  automatic_payment_methods: { enabled: true },
  receipt_email: user.email,
  description: note,
  metadata: {
    // ...existing metadata (user_id, account_id, store_id, pricebook_entry_ids, product_ids)
    payment_plan: '50_50',
    total_cents: String(totalCents),
    balance_cents: String(balanceCents)
  }
});
```

`setup_future_usage: 'off_session'` satisfies SCA/mandate rules **now** so the later charge goes through without the customer re-authenticating.

## Step 3 — Store the outstanding balance

On [`checkout/success/+page.server.ts`](src/routes/checkout/success/+page.server.ts), when `pi.status === 'succeeded'`, alongside the existing `service_contracts` UPSERT, record:

- `stripe_customer_id`
- `pi.payment_method` (saved card id)
- `balance_cents`
- `balance_status = 'pending'`

So the contract row knows a second charge is still owed.

## Step 4 — Charge 2: the balance, off-session

Triggered by whatever "later" means (service completion / scheduled job / admin action):

```ts
const balance = await getStripe().paymentIntents.create({
  amount: balanceCents,
  currency,
  customer: stripeCustomerId,
  payment_method: savedPaymentMethodId,
  off_session: true,  // customer isn't present
  confirm: true,      // charge right now
  metadata: { payment_plan: '50_50', kind: 'balance', service_contract_id: contractId }
});
```

## Step 5 — Handle off-session failures

Off-session charges can fail in ways on-session ones can't — the bank may demand authentication (`error.code === 'authentication_required'`) or decline. We can't force it through; we bring the customer back:

- Catch the error → mark `balance_status = 'action_required'`.
- Email a **Stripe-hosted link** (a Payment Link, or our own `/checkout/balance/[id]` page mounting the Payment Element on the failed PI's `client_secret`) to re-authenticate / re-enter the card.

## Step 6 — Webhook becomes non-optional

The missing `/api/stripe/webhook` is already flagged as a known risk (see [`AREA_10_STRIPE_PAYMENT.md`](AREA_10_STRIPE_PAYMENT.md), TC-STRIPE-42). For deposits it stops being optional: the balance charge happens with **no browser in the loop**, so the webhook is the only reliable way to learn its outcome.

Minimum events to handle:

- `payment_intent.succeeded` → mark matching contract's `balance_status = 'paid'`.
- `payment_intent.payment_failed` → `action_required` + trigger recovery email.

---

## Data model changes (summary)

- `users`: add `stripe_customer_id`.
- `service_contracts`: add `balance_cents`, `balance_status` (`pending` | `paid` | `action_required`), `saved_payment_method_id`, `stripe_customer_id`.

## Task checklist

- [ ] Add `stripe_customer_id` to `users` + Customer create/lookup helper
- [ ] Split amount → deposit/balance in `payment_intent/+server.ts`
- [ ] Add `customer` + `setup_future_usage` + new metadata to the deposit PI
- [ ] Persist balance state on the success/reconciliation page
- [ ] Build the off-session "charge balance" path + its trigger
- [ ] Off-session failure recovery (status + email + balance payment page/link)
- [ ] Add `/api/stripe/webhook` (`payment_intent.succeeded` / `payment_intent.payment_failed`)
- [ ] QA cases (mirror the `TC-STRIPE-*` style in AREA_10)

## Open questions

- What event triggers the balance charge? (service completion vs. fixed schedule vs. manual admin action)
- Refund policy if the service is cancelled after the deposit but before the balance.
- Does the 50/50 split apply to every service, or only above a price threshold?
