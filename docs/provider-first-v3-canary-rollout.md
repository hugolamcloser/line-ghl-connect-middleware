# Provider-first v3 tenant canary rollout

`GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST` is a comma-separated list of exact internal tenant IDs. Entries are trimmed, empty entries are ignored, and matching is case-sensitive. A missing or blank value enables no v3 tenants. A different-case value does not match, and `*` never enables all tenants.

The allowlist is evaluated when the Workflow Action runs and again when its provider callback is processed. Do not add or remove an active tenant while callbacks from earlier outbound messages may still be in flight. A post-create audit row cannot safely pin the lifecycle because a callback may arrive before that row is stored, and a successful HighLevel create intentionally remains successful if audit persistence fails.

## Preferred canary

Use a fresh, dedicated tenant with no earlier outbound provider messages. Production should initially deploy with an empty allowlist. Once enabled, keep the canary tenant allowlisted throughout the proof period instead of repeatedly adding and removing it.

## Enabling an existing tenant

1. Freeze Workflow Action submissions and manual outbound Custom messages for the tenant.
2. Keep the current allowlist unchanged while reconciling outstanding work.
3. Confirm every known provider dispatch has a terminal `sent` or `failed` delivery claim.
4. Reconcile HighLevel for unexplained pending outbound messages, including messages whose post-create audit write may have failed.
5. Use this state-based reconciliation instead of inventing a fixed waiting period. Do not proceed while any callback or message state is uncertain.
6. Change the allowlist once.
7. Wait until the change has settled and only one Railway deployment and effective configuration is active.
8. Resume with one controlled message at a time. Verify its HighLevel record, provider callback, atomic claim, LINE delivery, and final HighLevel status before sending the next message.

## Removing a canary tenant

1. Freeze new Workflow Action submissions and manual outbound Custom messages.
2. Reconcile every outstanding callback and pending HighLevel message to a terminal state.
3. Remove the tenant from the allowlist once.
4. Wait until only one Railway deployment and effective configuration is active before resuming normal sends.

## Emergency service-wide rollback

If the provider-first lifecycle must be disabled for the entire service, use both settings together:

```text
GHL_WORKFLOW_LINE_DELIVERY_MODE=direct_legacy
GHL_WORKFLOW_OUTBOUND_MIRROR_ENABLED=false
```

Freeze new sends and reconcile outstanding provider callbacks before applying the rollback whenever operational conditions permit.
