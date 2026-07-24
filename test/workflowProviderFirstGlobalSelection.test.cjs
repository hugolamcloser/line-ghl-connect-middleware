const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
process.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_GLOBAL_ENABLED = "false";
process.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = "";
process.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_DENYLIST = "";

const config = require("../dist/config/env");

const original = {
  mode: config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE,
  globalEnabled: config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_GLOBAL_ENABLED,
  allowlist: config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST,
  denylist: config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_DENYLIST
};

afterEach(() => {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = original.mode;
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_GLOBAL_ENABLED = original.globalEnabled;
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = original.allowlist;
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_DENYLIST = original.denylist;
});

function select(tenantId, overrides = {}) {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = overrides.mode ?? "provider_first";
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_GLOBAL_ENABLED =
    overrides.globalEnabled ?? false;
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = overrides.allowlist ?? "";
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_DENYLIST = overrides.denylist ?? "";
  return config.getWorkflowProviderFirstV3TenantRollout(tenantId);
}

test("global false plus an exact allowlist match selects provider_first_v3", () => {
  const result = select("tenant-exact", { allowlist: " tenant-other,tenant-exact " });

  assert.deepEqual(result, {
    globalEnabled: false,
    allowlistConfigured: true,
    denylistConfigured: false,
    tenantAllowlisted: true,
    tenantDenylisted: false,
    tenantV3Enabled: true,
    selectedLifecycle: "provider_first_v3"
  });
});

test("global false without an exact allowlist match selects provider_first_legacy", () => {
  const result = select("tenant-exact", { allowlist: "tenant-other" });

  assert.equal(result.tenantV3Enabled, false);
  assert.equal(result.selectedLifecycle, "provider_first_legacy");
});

test("global true selects provider_first_v3 for an unlisted tenant", () => {
  const result = select("tenant-unlisted", { globalEnabled: true });

  assert.equal(result.globalEnabled, true);
  assert.equal(result.tenantAllowlisted, false);
  assert.equal(result.tenantDenylisted, false);
  assert.equal(result.tenantV3Enabled, true);
  assert.equal(result.selectedLifecycle, "provider_first_v3");
});

test("global true does not select v3 for an exact denylisted tenant", () => {
  const result = select("tenant-denied", {
    globalEnabled: true,
    denylist: "tenant-other, tenant-denied"
  });

  assert.equal(result.denylistConfigured, true);
  assert.equal(result.tenantDenylisted, true);
  assert.equal(result.tenantV3Enabled, false);
  assert.equal(result.selectedLifecycle, "provider_first_legacy");
});

test("denylist overrides an exact allowlist match", () => {
  const result = select("tenant-exact", {
    allowlist: "tenant-exact",
    denylist: "tenant-exact"
  });

  assert.equal(result.tenantAllowlisted, true);
  assert.equal(result.tenantDenylisted, true);
  assert.equal(result.tenantV3Enabled, false);
  assert.equal(result.selectedLifecycle, "provider_first_legacy");
});

test("wildcards are ignored and never become an exact tenant match", () => {
  const result = select("*", { allowlist: "*", denylist: "*" });

  assert.equal(result.allowlistConfigured, false);
  assert.equal(result.denylistConfigured, false);
  assert.equal(result.tenantAllowlisted, false);
  assert.equal(result.tenantDenylisted, false);
  assert.equal(result.tenantV3Enabled, false);
});

test("direct_legacy overrides global mode", () => {
  const result = select("tenant-normal", {
    mode: "direct_legacy",
    globalEnabled: true
  });

  assert.equal(result.tenantV3Enabled, false);
  assert.equal(result.selectedLifecycle, "direct_legacy");
});
