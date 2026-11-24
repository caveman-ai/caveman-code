---
name: stripe-integration
description: Build or change a Stripe integration in this codebase against current Stripe docs and API, testing in a sandbox. Use when adding checkout, subscriptions, webhooks or any other Stripe feature.
---

# Build a Stripe integration

1. Look up the current Stripe docs for the feature before writing code; Stripe's recommended flow changes, and remembered examples are often outdated.
2. Find the existing Stripe setup in this repository (SDK version, API version pin, webhook handler) and build on it.
3. Use sandbox or test-mode objects only while building. Never create live-mode objects unless the user explicitly asks.
4. Handle webhooks: verify signatures, make handlers idempotent, and do not rely on redirect pages for fulfilment.
5. Keep keys in environment variables; never print or commit them.
6. Test the flow end to end in the sandbox and list the webhook events the integration depends on.
