const now = Date.now();
const ago = (m) => new Date(now - m * 60000).toISOString();
export function mockHass(over = {}) {
  const st = (state, attributes, m) => ({ state, attributes, last_changed: ago(m) });
  return {
    language: "en",
    states: {
      "binary_sensor.front_door": st("on", { friendly_name: "Front door", device_class: "door" }, 3),
      "binary_sensor.hallway_motion": st("off", { friendly_name: "Hallway motion", device_class: "motion" }, 12),
      "binary_sensor.garage_door": st("off", { friendly_name: "Garage door", device_class: "door" }, 95),
      "sensor.living_room_temperature": st("21.4", { friendly_name: "Living room", unit_of_measurement: "°C" }, 30),
      "lock.back_door": st("locked", { friendly_name: "Back door lock" }, 400),
      "light.kitchen": st("on", { friendly_name: "Kitchen light" }, 55),
      "sensor.unrelated": st("5", { friendly_name: "Unrelated" }, 1),
    },
    callApi: async (method, path) => {
      if (!path.startsWith("calendars/calendar.family")) return [];
      return [
        { summary: "Trash pickup", start: { dateTime: new Date(now + 20 * 3600000).toISOString() }, end: {}, location: "Curb" },
        { summary: "Dentist", start: { dateTime: new Date(now + 3 * 86400000).toISOString() }, end: {} },
      ];
    },
    connection: {
      subscribeMessage: async (cb) => {
        cb({ type: "current", notifications: { n1: { notification_id: "n1", title: "Update available", message: "Home Assistant 2026.11 is ready.", created_at: ago(8) } } });
        return () => {};
      },
    },
    ...over,
  };
}
