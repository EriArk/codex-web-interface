import assert from "node:assert/strict";
import test from "node:test";
import { nativeSettings } from "../ops/gpt-native/renderer-settings.mjs";

function fixture() {
  const versions = ["latest", "5.6"].map((id, i) => ({
    id,
    label: i ? "GPT-5.6 Sol" : "Latest",
    enabled: true,
    presets: [
      { id: 0, label: "Instant", model: "instant", effort: null, available: true },
      { id: 1, label: "Medium", model: "thinking", effort: "standard", available: true },
      { id: 6, label: "Extra High", model: "thinking", effort: "max", available: true },
    ],
  }));
  let version = 0,
    index = 0,
    expanded = false,
    advanced = false,
    mutations = 0,
    checks = 0;
  const config = {
    busy: false,
    changed: false,
    ambiguous: false,
    locked: false,
    ignoreArrow: false,
    status: null,
    accountChangeAt: null,
  };
  const el = (attrs = {}, onClick = () => {}) => ({
    textContent: "",
    disabled: false,
    getClientRects: () => [1],
    closest: () => null,
    getAttribute: (k) => attrs[k] ?? null,
    hasAttribute: (k) => Object.hasOwn(attrs, k),
    click: () => {
      mutations++;
      onClick();
    },
  });
  const trigger = el({}, () => {
    expanded = true;
  });
  trigger.getAttribute = (k) =>
    k === "aria-expanded" ? String(expanded) : k === "aria-controls" ? "picker" : null;
  trigger.dispatchEvent = (event) => {
    if (event.key === "Escape") expanded = false;
  };
  const slider = el({ "aria-describedby": "status help" });
  slider.dispatchEvent = (event) => {
    mutations++;
    if (!config.ignoreArrow) index += event.key === "ArrowRight" ? 1 : -1;
  };
  const status = el({ role: "status" });
  Object.defineProperty(status, "textContent", {
    get: () => config.status ?? `${versions[version].presets[index].label}, ${index + 1} of 3.`,
  });
  const toggle = el({}, () => {
    advanced = true;
  });
  const radios = versions.map((v, i) => {
    const e = el({}, () => {
      version = i;
      index = 0;
      advanced = false;
    });
    e.textContent = v.label;
    e.getAttribute = (k) => (k === "aria-checked" ? String(version === i) : null);
    e.hasAttribute = (k) => k === "aria-describedby" && config.locked;
    e.closest = () => (advanced ? null : {});
    return e;
  });
  const menu = el({ role: "menu" });
  menu.contains = (e) => e === status;
  menu.querySelectorAll = (s) =>
    s === '[role="menuitemradio"]'
      ? radios
      : s === "[data-reasoning-slider]"
        ? [slider]
        : s === "[data-model-picker-view-toggle]"
          ? [toggle]
          : [];
  const doc = {
    querySelectorAll: () => (config.ambiguous ? [trigger, trigger] : [trigger]),
    getElementById: (id) => (id === "picker" && expanded ? menu : id === "status" ? status : null),
  };
  const runtime = {
    document: doc,
    KeyboardEvent: class {
      constructor(_type, options) {
        Object.assign(this, options);
      }
    },
  };
  const read = async () => ({ versions });
  const control = async () => {
    if (config.accountChangeAt !== null && ++checks >= config.accountChangeAt)
      throw Error("NATIVE_ACCOUNT_CHANGED");
    return {
      selected: !config.changed,
      composerReady: true,
      hasDraft: config.busy,
      stopAvailable: false,
    };
  };
  const request = {
    operation: "inspectSettings",
    conversationId: "chat",
    accountFingerprint: "bound",
  };
  return {
    config,
    versions,
    runtime,
    read,
    control,
    trigger,
    request,
    run: (overrides) =>
      nativeSettings({ ...request, ...overrides }, read, control, async () => ({}), runtime),
    state: () => ({ version, index, expanded, mutations }),
  };
}

test("picker inspection reads native preset identity and closes only its menu", async () => {
  const f = fixture(),
    result = await f.run();
  assert.equal(result.model, "instant");
  assert.equal(result.effort, null);
  assert.equal(result.versionId, "latest");
  assert.equal(result.verified, true);
  assert.equal(f.state().expanded, false);
  assert.equal(f.state().index, 0);
});
test("model selection switches native version, then maps nonsequential preset ID", async () => {
  const f = fixture();
  const result = await f.run({ operation: "selectSettings", versionId: "5.6", presetId: 6 });
  assert.equal(result.versionId, "5.6");
  assert.equal(result.presetId, 6);
  assert.equal(result.effort, "max");
  assert.equal(f.state().index, 2);
  assert.equal(f.state().expanded, false);
});
test("unknown and locked requested presets never open or mutate picker", async () => {
  const f = fixture();
  f.versions[0].presets[2].available = false;
  for (const presetId of [9, 2, 6])
    await assert.rejects(
      f.run({ operation: "selectSettings", versionId: "latest", presetId }),
      /SETTING_UNAVAILABLE/,
    );
  assert.equal(f.state().mutations, 0);
});
test("draft, active manual picker, ambiguous trigger and wrong chat are preserved", async () => {
  const f = fixture();
  f.config.busy = true;
  await assert.rejects(f.run(), /NOT_READY/);
  assert.equal(f.state().mutations, 0);
  f.config.busy = false;
  f.config.changed = true;
  await assert.rejects(f.run(), /NOT_READY/);
  f.config.changed = false;
  f.config.ambiguous = true;
  await assert.rejects(f.run(), /PICKER_UNAVAILABLE/);
  f.config.ambiguous = false;
  f.trigger.click();
  await assert.rejects(f.run(), /PICKER_BUSY/);
  assert.equal(f.state().expanded, true);
});
test("account change blocks next mutation and does not close another account menu", async () => {
  const f = fixture();
  f.config.accountChangeAt = 3;
  // Change at the first step after opening: only opening is permitted.
  await assert.rejects(
    f.run({ operation: "selectSettings", versionId: "latest", presetId: 1 }),
    /ACCOUNT_CHANGED/,
  );
  assert.equal(f.state().index, 0);
  assert.equal(f.state().expanded, true);
});
test("unconfirmed native key event fails instead of claiming selection succeeded", async () => {
  const f = fixture();
  f.config.ignoreArrow = true;
  await assert.rejects(
    f.run({ operation: "selectSettings", versionId: "latest", presetId: 1 }),
    /SETTING_UNCONFIRMED/,
  );
});
test("catalog/native slider disagreement and locked model access are rejected", async () => {
  const f = fixture();
  f.config.status = "Medium, 2 of 6.";
  await assert.rejects(f.run(), /INVALID_SELECTION/);
  f.config.status = null;
  f.config.locked = true;
  await assert.rejects(
    f.run({ operation: "selectSettings", versionId: "5.6", presetId: 1 }),
    /SETTING_UNAVAILABLE/,
  );
  assert.equal(f.state().version, 0);
});
test("concurrent settings calls cannot take over the same native picker", async () => {
  const f = fixture();
  f.runtime[Symbol.for("codex-web.native-settings")] = true;
  await assert.rejects(f.run(), /SETTINGS_BUSY/);
  assert.equal(f.state().mutations, 0);
});
