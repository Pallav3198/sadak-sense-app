const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../web/shared/env.js");

test("India AQI follows the CPCB bands, worst pollutant wins", () => {
  assert.deepEqual(E.indiaAqi(25, 40), { aqi: 42, band: "Good" });
  assert.equal(E.indiaAqi(127, 128).band, "Very Poor");
  assert.equal(E.indiaAqi(100, 300).aqi, 250);
  assert.equal(E.indiaAqi(400, 700).band, "Severe");
  assert.equal(E.indiaAqi(undefined, undefined), null);
});

test("advice: fog first, then rain, air and heat", () => {
  const a = E.advise({ visibilityM: 380, rainProbNext2h: 70, pm25: 180, pm10: 260, tempC: 41 }, "English");
  assert.deepEqual(a.map((x) => x.key), ["fog", "rain", "aqi", "heat"]);
  assert.match(a[0].text, /400 metres/);
  assert.match(a[2].text, /AQI \d+/);
});

test("a clear, clean day gives no advice", () => {
  assert.deepEqual(E.advise({ visibilityM: 9000, rainMm: 0, rainProbNext2h: 10, pm25: 20, pm10: 30, tempC: 24 }), []);
});

test("Hinglish advice", () => {
  assert.match(E.advise({ pm25: 150 }, "Hinglish")[0].text, /recirculation aur purifier/);
});

test("live data is read from Open-Meteo and survives an outage", async () => {
  const fake = async (url) => ({ ok: true, json: async () => url.includes("air-quality")
    ? { current: { pm2_5: 127, pm10: 128 } }
    : { current: { temperature_2m: 19, precipitation: 0, weather_code: 45, visibility: 600 }, hourly: { precipitation_probability: [10, 30] } } });
  const env = await E.fetchEnv(28.63, 77.21, { fetch: fake });
  assert.deepEqual(env, { tempC: 19, code: 45, rainMm: 0, visibilityM: 600, rainProbNext2h: 30, pm25: 127, pm10: 128 });
  assert.equal(await E.fetchEnv(28.63, 77.21, { fetch: async () => { throw new Error("offline"); } }), null);
});
