import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mockHass } from "./fixtures.mjs";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
for (const k of ["window", "document", "HTMLElement", "customElements", "CustomEvent", "Event"]) {
  Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
}
const mod = await import("../activity-feed-card.js");
const tick = () => new Promise((r) => setTimeout(r, 20));
const make = async (config, hass = mockHass()) => {
  const el = document.createElement("activity-feed-card");
  document.body.appendChild(el);
  el.setConfig(config);
  el.hass = hass;
  await tick();
  return el;
};
const rows = (el) => [...el.shadowRoot.querySelectorAll(".row")];
const titles = (el) => rows(el).map((r) => r.querySelector(".title").textContent);

test("registers element and customCards entry", () => {
  assert.ok(customElements.get("activity-feed-card"));
  assert.ok(window.customCards.some((c) => c.type === "activity-feed-card"));
});

test("renders listed entities newest first with state text", async () => {
  const el = await make({ entities: ["binary_sensor.front_door", "binary_sensor.hallway_motion", "sensor.living_room_temperature"], show_notifications: false });
  assert.deepEqual(titles(el), ["Front door", "Hallway motion", "Living room"]);
  assert.match(rows(el)[1].textContent, /Clear/);
  assert.match(rows(el)[2].textContent, /21\.4 °C/);
  assert.match(rows(el)[0].querySelector("time").textContent, /3 minutes ago/);
});

test("id_filter pulls matching entities and skips others", async () => {
  const el = await make({ id_filter: "^binary_sensor\\.", show_notifications: false });
  assert.equal(rows(el).length, 3);
  assert.ok(!titles(el).includes("Unrelated"));
});

test("no duplicate when entity is listed and also matches id_filter", async () => {
  const el = await make({ entities: ["binary_sensor.front_door"], id_filter: "front_door", show_notifications: false });
  assert.equal(rows(el).length, 1);
});

test("persistent notifications and calendar events appear", async () => {
  const el = await make({ calendars: ["calendar.family"], entities: ["lock.back_door"] });
  await tick();
  const t = titles(el);
  assert.ok(t.includes("Update available"));
  assert.ok(t.includes("Trash pickup"));
  assert.ok(t.includes("Dentist"));
  assert.equal(t[0], "Dentist");
});

test("single calendar string and singular key accepted", async () => {
  const el = await make({ calendar: "calendar.family", show_notifications: false });
  await tick();
  assert.ok(titles(el).includes("Trash pickup"));
});

test("max_item_count limits rows", async () => {
  const el = await make({ id_filter: ".", max_item_count: 2, show_notifications: false });
  assert.equal(rows(el).length, 2);
});

test("show_empty false hides the card; true shows empty text", async () => {
  const hidden = await make({ entities: ["sensor.does_not_exist"], show_empty: false, show_notifications: false });
  assert.equal(hidden.style.display, "none");
  const shown = await make({ entities: ["sensor.does_not_exist"], show_notifications: false, empty_text: "Quiet" });
  assert.match(shown.shadowRoot.textContent, /Quiet/);
});

test("tap fires hass-more-info with entity id; disabled per entity", async () => {
  const el = await make({ entities: ["binary_sensor.front_door", { entity: "light.kitchen", more_info_on_tap: false }], show_notifications: false });
  let got;
  el.addEventListener("hass-more-info", (e) => (got = e.detail.entityId));
  rows(el)[0].click();
  assert.equal(got, "binary_sensor.front_door");
  const kitchen = rows(el).find((r) => r.textContent.includes("Kitchen"));
  assert.equal(kitchen.getAttribute("role"), null);
});

test("escapes HTML in notification text", async () => {
  const hass = mockHass();
  hass.connection.subscribeMessage = async (cb) => {
    cb({ type: "current", notifications: { x: { notification_id: "x", title: "<img src=x onerror=alert(1)>", message: "a&b", created_at: new Date().toISOString() } } });
    return () => {};
  };
  const el = await make({ entities: [] }, hass);
  assert.equal(el.shadowRoot.querySelector("img"), null);
  assert.match(el.shadowRoot.textContent, /<img src=x/);
});

test("a failing calendar does not blank the card", async () => {
  const hass = mockHass({ callApi: async () => { throw new Error("boom"); } });
  const el = await make({ calendars: ["calendar.x"], entities: ["lock.back_door"], show_notifications: false }, hass);
  await tick();
  assert.deepEqual(titles(el), ["Back door lock"]);
});

test("invalid configs throw readable errors", () => {
  const el = document.createElement("activity-feed-card");
  assert.throws(() => el.setConfig(null), /Invalid configuration/);
  assert.throws(() => el.setConfig({ id_filter: "(" }), /regular expression/);
  assert.throws(() => el.setConfig({ entities: [{ name: "x" }] }), /entity id/);
  assert.throws(() => el.setConfig({ entities: "light.a" }), /list/);
});

test("license key is accepted and ignored (no paywall)", async () => {
  const el = await make({ entities: ["lock.back_door"], license: "ABC", show_notifications: false });
  assert.equal(rows(el).length, 1);
});

test("relativeTime", () => {
  const n = new Date("2026-01-01T12:00:00Z");
  assert.match(mod.relativeTime(new Date(n - 2 * 3600000), n), /2 hours ago/);
  assert.match(mod.relativeTime(new Date(+n + 2 * 86400000), n), /in 2 days/);
});

test("editor emits config-changed", async () => {
  const ed = document.createElement("activity-feed-card-editor");
  ed.setConfig({ entities: [{ entity: "light.kitchen" }] });
  let cfg;
  ed.addEventListener("config-changed", (e) => (cfg = e.detail.config));
  const form = ed.querySelector("ha-form");
  assert.deepEqual(form.data.entities, ["light.kitchen"]);
  form.dispatchEvent(new CustomEvent("value-changed", { detail: { value: { title: "T", entities: ["light.kitchen"] } } }));
  assert.equal(cfg.title, "T");
});

test("cleanup: disconnect clears timers", () => {
  document.body.innerHTML = "";
  dom.window.close();
});
