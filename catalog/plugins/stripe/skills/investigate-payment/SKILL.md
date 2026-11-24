---
name: investigate-payment
description: Investigate a Stripe payment, charge, invoice or subscription problem by reading the objects and their events, and explain what happened. Use when asked why a payment failed, a customer was charged twice, or a subscription is in a given state.
---

# Investigate a payment

1. Identify the account and mode (sandbox or live) and the object: customer, payment, invoice or subscription ID.
2. Read the object and its related objects (charge, payment method, invoice, refunds) and its event history in order.
3. Explain the timeline in plain words and the reason Stripe gives (decline code, dunning step, proration).
4. If the code in this repository caused it (wrong parameters, a missed webhook), point at the file and propose a fix.
5. Do not refund, cancel or modify anything without the user's explicit go-ahead for that exact action.
