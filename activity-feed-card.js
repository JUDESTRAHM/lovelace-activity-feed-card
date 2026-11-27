/*!
 * Activity Feed Card for Home Assistant
 * MIT License. Independent implementation; no code from other cards.
 * A feed of entity changes, calendar events and persistent notifications.
 */
const CARD_VERSION = "1.0.0";
// Reserved for a future optional supporter tier. Nothing is gated today.
const PRO_ENABLED = false;

const DOMAIN_ICONS = {
  binary_sensor: "mdi:checkbox-marked-circle-outline",
  sensor: "mdi:eye",
  light: "mdi:lightbulb",
  switch: "mdi:toggle-switch",
  lock: "mdi:lock",
  cover: "mdi:window-shutter",
  climate: "mdi:thermostat",
  person: "mdi:account",
  device_tracker: "mdi:map-marker",
  media_player: "mdi:play-circle",
  alarm_control_panel: "mdi:shield-home",
};
const BINARY_ICONS = {
  motion: "mdi:motion-sensor",
  door: "mdi:door",
  window: "mdi:window-open",
  occupancy: "mdi:home-account",
  smoke: "mdi:smoke-detector",
  moisture: "mdi:water-alert",
};
const DEFAULTS = {
  title: "Activity",
  max_item_count: 20,
  show_empty: true,
  empty_text: "Nothing to show",
  show_icons: true,
  show_notifications: true,
  more_info_on_tap: true,
  state_color: true,
  days_ahead: 7,
  calendar_refresh_minutes: 5,
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function relativeTime(date, now = new Date(), locale) {
  const diff = (date.getTime() - now.getTime()) / 1000;
  const abs = Math.abs(diff);
  let rtf;
  try { rtf = new Intl.RelativeTimeFormat(locale || undefined, { numeric: "auto" }); } catch (e) { rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" }); }
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

export function normalizeConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Invalid configuration");
  const c = { ...DEFAULTS, ...config };
  // Accept the singular key as well as the plural
  let cals = c.calendars ?? c.calendar ?? [];
  if (typeof cals === "string") cals = [cals];
  if (!Array.isArray(cals)) throw new Error("calendars must be a list of calendar entity ids");
  c.calendars = cals;
  const ents = c.entities ?? [];
  if (!Array.isArray(ents)) throw new Error("entities must be a list");
  c.entities = ents.map((e) => {
    if (typeof e === "string") return { entity: e };
    if (e && typeof e.entity === "string") return { ...e };
    throw new Error("Each entity needs an entity id");
  });
  if (c.id_filter) {
    try { c._idRegex = new RegExp(c.id_filter); } catch (e) { throw new Error("id_filter is not a valid regular expression"); }
  }
  c.max_item_count = Math.max(1, Number(c.max_item_count) || DEFAULTS.max_item_count);
  c.days_ahead = Math.max(1, Number(c.days_ahead) || DEFAULTS.days_ahead);
  if (c.license && !PRO_ENABLED) { /* accepted and ignored: no paid features exist yet */ }
  return c;
}

export class ActivityFeedCard extends HTMLElement {
  constructor() {
    super();
    this._notifications = [];
    this._events = [];
    this._eventsFetchedAt = 0;
    this._sig = "";
    this.attachShadow({ mode: "open" });
  }

  static getStubConfig() {
    return { title: "Activity", entities: [], id_filter: "^binary_sensor\\." };
  }

  static getConfigElement() {
    return document.createElement("activity-feed-card-editor");
  }

  setConfig(config) {
    this._config = normalizeConfig(config);
    this._sig = "";
    this._eventsFetchedAt = 0;
    if (this._hass) this._update();
  }

  getCardSize() {
    return Math.min(8, 1 + Math.ceil((this._config?.max_item_count ?? 5) / 2));
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;
    if (first && this._config.show_notifications) this._loadNotifications();
    this._update();
  }

  async _loadNotifications() {
    const h = this._hass;
    try {
      if (h?.connection?.subscribeMessage) {
        this._unsub = await h.connection.subscribeMessage(
          (msg) => this._onNotificationMsg(msg),
          { type: "persistent_notification/subscribe" }
        );
      } else if (h?.callWS) {
        const res = await h.callWS({ type: "persistent_notification/get" });
        this._notifications = Object.values(res || {});
        this._update();
      }
    } catch (e) {
      this._notifError = String(e?.message || e);
    }
  }

  _onNotificationMsg(msg) {
    const map = new Map(this._notifications.map((n) => [n.notification_id, n]));
    if (msg?.type === "current") map.clear();
    const list = msg?.notifications || {};
    for (const [id, n] of Object.entries(list)) map.set(id, n);
    if (msg?.type === "removed") for (const id of Object.keys(list)) map.delete(id);
    this._notifications = [...map.values()];
    this._update();
  }

  connectedCallback() {
    // keep the relative timestamps fresh
    this._tick = setInterval(() => { this._sig = ""; this._update(); }, 60000);
    if (this._tick && this._tick.unref) this._tick.unref();
  }

  disconnectedCallback() {
    clearInterval(this._tick);
    if (typeof this._unsub === "function") { this._unsub(); this._unsub = undefined; }
  }

  async _fetchEvents() {
    const c = this._config;
    if (!c.calendars.length || !this._hass?.callApi) return;
    const now = Date.now();
    if (now - this._eventsFetchedAt < c.calendar_refresh_minutes * 60000) return;
    this._eventsFetchedAt = now;
    const start = new Date(now).toISOString();
    const end = new Date(now + c.days_ahead * 86400000).toISOString();
    const out = [];
    await Promise.all(
      c.calendars.map(async (cal) => {
        try {
          const evs = await this._hass.callApi("GET", `calendars/${cal}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
          for (const ev of evs || []) out.push({ ...ev, _calendar: cal });
        } catch (e) { /* one failing calendar must not blank the card */ }
      })
    );
    this._events = out;
    this._sig = "";
    this._update();
  }

  _collect() {
    const c = this._config;
    const h = this._hass;
    const items = [];
    const seen = new Set();
    const add = (cfg) => {
      const st = h.states[cfg.entity];
      if (!st || seen.has(cfg.entity)) return;
      seen.add(cfg.entity);
      const domain = cfg.entity.split(".")[0];
      const dc = st.attributes?.device_class;
      const icon = cfg.icon || st.attributes?.icon || (domain === "binary_sensor" && BINARY_ICONS[dc]) || DOMAIN_ICONS[domain] || "mdi:circle-medium";
      const name = cfg.name || st.attributes?.friendly_name || cfg.entity;
      items.push({
        kind: "entity", ts: new Date(st.last_changed), title: name,
        text: cfg.format_state === false ? "" : this._stateText(st),
        icon, entity: cfg.entity, on: ["on", "open", "unlocked", "home", "playing", "detected"].includes(st.state),
        tap: cfg.more_info_on_tap ?? c.more_info_on_tap,
      });
    };
    c.entities.forEach(add);
    if (c._idRegex) Object.keys(h.states).filter((id) => c._idRegex.test(id)).sort().forEach((id) => add({ entity: id }));
    if (c.show_notifications) {
      for (const n of this._notifications) {
        items.push({ kind: "notification", ts: new Date(n.created_at), title: n.title || "Notification", text: n.message || "", icon: "mdi:bell", on: true });
      }
    }
    for (const ev of this._events) {
      const s = ev.start?.dateTime || ev.start?.date || ev.start;
      if (!s) continue;
      items.push({ kind: "calendar", ts: new Date(s), title: ev.summary || "Event", text: ev.location || "", icon: "mdi:calendar", on: false });
    }
    items.sort((a, b) => b.ts - a.ts);
    return items.slice(0, c.max_item_count);
  }

  _stateText(st) {
    const unit = st.attributes?.unit_of_measurement;
    const s = st.state;
    if (s === "on") return st.attributes?.device_class === "motion" ? "Detected" : "On";
    if (s === "off") return st.attributes?.device_class === "motion" ? "Clear" : "Off";
    return unit ? `${s} ${unit}` : s.charAt(0).toUpperCase() + s.slice(1);
  }

  _update() {
    if (!this._config || !this._hass) return;
    this._fetchEvents();
    const items = this._collect();
    const sig = JSON.stringify(items.map((i) => [i.kind, i.title, i.text, +i.ts, i.on])) + (this._config.title || "");
    if (sig === this._sig) return;
    this._sig = sig;
    this._render(items);
  }

  _render(items) {
    const c = this._config;
    const locale = this._hass.locale?.language || this._hass.language;
    const now = new Date();
    if (!items.length && !c.show_empty) { this.style.display = "none"; this.shadowRoot.innerHTML = ""; return; }
    this.style.display = "";
    const rows = items.map((i, idx) => {
      const color = c.state_color && i.on ? "var(--state-active-color, var(--primary-color, #03a9f4))" : "var(--secondary-text-color, #727272)";
      return `<li class="row ${i.kind}" data-idx="${idx}" ${i.tap ? 'tabindex="0" role="button"' : ""}>
        ${c.show_icons ? `<span class="ico" style="color:${color}"><ha-icon icon="${esc(i.icon)}"></ha-icon></span>` : ""}
        <span class="main"><span class="title">${esc(i.title)}</span>${i.text ? `<span class="text">${esc(i.text)}</span>` : ""}</span>
        <time datetime="${isNaN(i.ts) ? "" : i.ts.toISOString()}">${isNaN(i.ts) ? "" : esc(relativeTime(i.ts, now, locale))}</time>
      </li>`;
    }).join("");
    this.shadowRoot.innerHTML = `<style>
      ha-card{overflow:hidden}
      .head{padding:16px 16px 4px;font-size:var(--ha-card-header-font-size,20px);color:var(--ha-card-header-color,var(--primary-text-color))}
      ul{list-style:none;margin:0;padding:4px 0 8px}
      .row{display:flex;align-items:center;gap:12px;padding:8px 16px;color:var(--primary-text-color)}
      .row[role=button]{cursor:pointer}.row[role=button]:hover{background:var(--secondary-background-color,rgba(127,127,127,.12))}
      .ico{display:inline-flex;--mdc-icon-size:22px;flex:none}
      .main{display:flex;flex-direction:column;flex:1;min-width:0}
      .title{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .text{font-size:.85em;color:var(--secondary-text-color);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      time{font-size:.8em;color:var(--secondary-text-color);flex:none}
      .empty{padding:16px;color:var(--secondary-text-color)}
    </style>
    <ha-card>${c.title ? `<div class="head">${esc(c.title)}</div>` : ""}
    ${items.length ? `<ul>${rows}</ul>` : `<div class="empty">${esc(c.empty_text)}</div>`}</ha-card>`;
    this.shadowRoot.querySelectorAll(".row[role=button]").forEach((el) => {
      const open = () => {
        const it = items[Number(el.dataset.idx)];
        if (it?.entity) this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: it.entity } }));
      };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
  }
}

const EDITOR_SCHEMA = [
  { name: "title", selector: { text: {} } },
  { name: "entities", selector: { entity: { multiple: true } } },
  { name: "calendars", selector: { entity: { multiple: true, filter: { domain: "calendar" } } } },
  { name: "id_filter", selector: { text: {} } },
  { name: "max_item_count", selector: { number: { min: 1, max: 100, mode: "box" } } },
  { name: "days_ahead", selector: { number: { min: 1, max: 60, mode: "box" } } },
  { name: "show_notifications", selector: { boolean: {} } },
  { name: "show_icons", selector: { boolean: {} } },
  { name: "state_color", selector: { boolean: {} } },
  { name: "more_info_on_tap", selector: { boolean: {} } },
  { name: "show_empty", selector: { boolean: {} } },
];

export class ActivityFeedCardEditor extends HTMLElement {
  setConfig(config) { this._config = config; this._render(); }
  set hass(h) { this._hass = h; if (this._form) this._form.hass = h; }
  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => s.name.replace(/_/g, " ");
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const config = { ...ev.detail.value };
        // Keep entity rows that use object form: only plain ids are edited here
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    const cfg = { ...DEFAULTS, ...this._config };
    cfg.entities = (cfg.entities || []).map((e) => (typeof e === "string" ? e : e.entity));
    this._form.data = cfg;
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("activity-feed-card")) customElements.define("activity-feed-card", ActivityFeedCard);
  if (!customElements.get("activity-feed-card-editor")) customElements.define("activity-feed-card-editor", ActivityFeedCardEditor);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === "activity-feed-card")) {
    window.customCards.push({
      type: "activity-feed-card",
      name: "Activity Feed Card",
      description: "A feed of entity changes, calendar events and notifications.",
      preview: false,
    });
  }
  console.info(`%c ACTIVITY-FEED-CARD %c v${CARD_VERSION} `, "color:white;background:#03a9f4;font-weight:700", "color:#03a9f4;background:white");
}
