# Provider-first v3 rollout

`GHL_WORKFLOW_PROVIDER_FIRST_V3_GLOBAL_ENABLED` defaults to `false`. When it is `true` and `GHL_WORKFLOW_LINE_DELIVERY_MODE=provider_first`, every otherwise eligible tenant selects the v3 lifecycle unless that exact internal tenant ID is denylisted.

`GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST` remains a comma-separated list of exact internal tenant IDs for controlled overrides while global mode is false. `GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_DENYLIST` is also a comma-separated exact-ID list and overrides both global mode and an allowlist match. Entries are trimmed, empty entries are ignored, matching is case-sensitive, and `*` never matches a tenant or enables global behavior.

The shared selection order is:

1. `direct_legacy` selects the direct legacy lifecycle.
2. A denylisted tenant selects the provider-first legacy lifecycle.
3. Global mode or an exact allowlist match selects provider-first v3.
4. Otherwise provider-first legacy remains selected.

Lifecycle selection does not replace eligibility checks. Exact tenant/location ownership, a configured provider, a usable OAuth installation, mapping and active LINE channel resolution, callback provider validation, valid HighLevel message identity, and the atomic claim remain fail-closed requirements in their existing delivery paths.

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

## Rollback

The immediate feature rollback is:

```text
GHL_WORKFLOW_PROVIDER_FIRST_V3_GLOBAL_ENABLED=false
```

This restores the exact-allowlist rollout. If the provider-first lifecycle must be disabled for the entire service, use both settings together:

```text
GHL_WORKFLOW_LINE_DELIVERY_MODE=direct_legacy
GHL_WORKFLOW_OUTBOUND_MIRROR_ENABLED=false
```

Freeze new sends and reconcile outstanding provider callbacks before applying the rollback whenever operational conditions permit.
