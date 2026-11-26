// Sadak Sense air and weather: free Open-Meteo data (no key), turned into short in-car advice that the
// car can act on: recirculate cabin air, pre-cool, fog lights, leave early before rain floods an
// underpass. AQI uses India's CPCB National AQI breakpoints, applied to current PM levels (CPCB uses
// 24-hour averages, so this is an indication). Pure functions plus one fetch; shared with the tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SadakEnv = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const PM25 = [[0, 30, 0, 50], [30, 60, 50, 100], [60, 90, 100, 200], [90, 120, 200, 300], [120, 250, 300, 400], [250, 500, 400, 500]];
  const PM10 = [[0, 50, 0, 50], [50, 100, 50, 100], [100, 250, 100, 200], [250, 350, 200, 300], [350, 430, 300, 400], [430, 600, 400, 500]];
  const BANDS = [[50, "Good"], [100, "Satisfactory"], [200, "Moderate"], [300, "Poor"], [400, "Very Poor"], [Infinity, "Severe"]];
  const sub = (c, table) => {
    if (!Number.isFinite(c) || c < 0) return null;
    const [lo, hi, ilo, ihi] = table.find(([, h]) => c <= h) || table[table.length - 1];
    return Math.round(Math.min(500, ilo + ((Math.min(c, hi) - lo) * (ihi - ilo)) / (hi - lo)));
  };
  // India National AQI: the worse of the PM2.5 and PM10 sub-indices.
  function indiaAqi(pm25, pm10) {
    const v = [sub(pm25, PM25), sub(pm10, PM10)].filter((x) => x != null);
    if (!v.length) return null;
    const aqi = Math.max(...v);
    return { aqi, band: BANDS.find(([max]) => aqi <= max)[1] };
  }

  const SKY = (code) => code == null ? "" : code === 0 ? "Clear" : code <= 3 ? "Cloudy" : code <= 48 ? "Fog" : code <= 67 || (code >= 80 && code <= 82) ? "Rain" : code <= 77 ? "Snow" : code >= 95 ? "Thunderstorm" : "Rain";

  // env: { tempC, code, rainMm, visibilityM, rainProbNext2h, pm25, pm10 }
  // Returns advice, most important first: { key, level: "warn" | "info", text, act }
  function advise(env, lang = "English") {
    const T = (en, hl, hi) => ({ English: en, Hinglish: hl, Hindi: hi }[lang] || en);
    const out = [], a = indiaAqi(env.pm25, env.pm10);
    if (Number.isFinite(env.visibilityM) && env.visibilityM < 1000) {
      const m = Math.max(50, Math.round(env.visibilityM / 50) * 50);
      out.push({ key: "fog", level: "warn", act: T("Fog lights on (demo)", "Fog lights on (demo)", "फ़ॉग लाइट चालू (डेमो)"),
        text: T(`Fog ahead: visibility about ${m} metres. Fog lights are on; keep extra distance.`, `Aage dhundh hai, lagbhag ${m} metre tak hi dikh raha hai. Fog lights on kar di hain, doori rakhiye.`, `आगे धुंध है, लगभग ${m} मीटर तक ही दिख रहा है। फ़ॉग लाइट चालू कर दी हैं, दूरी रखें।`) });
    }
    if ((env.rainMm || 0) >= 0.5 || (env.rainProbNext2h || 0) >= 60) {
      const now = (env.rainMm || 0) >= 0.5;
      out.push({ key: "rain", level: "warn", act: T("Underpass watch on", "Underpass watch on", "अंडरपास पर नज़र"),
        text: now ? T("It is raining. Underpasses on your route can flood; I will warn you if cars start getting stuck.", "Baarish ho rahi hai. Raaste ke underpass mein paani bhar sakta hai, gaadiyan atki toh main bata dunga.", "बारिश हो रही है। रास्ते के अंडरपास में पानी भर सकता है, गाड़ियाँ अटकीं तो मैं बता दूँगा।")
          : T(`Rain is likely in the next 2 hours (${env.rainProbNext2h}%). Leave a little early; underpasses on your route flood often.`, `Agle 2 ghante mein baarish ke chances hain, ${env.rainProbNext2h} percent. Thoda jaldi nikliye, raaste ke underpass mein aksar paani bharta hai.`, `अगले 2 घंटे में बारिश की संभावना ${env.rainProbNext2h} प्रतिशत है। थोड़ा जल्दी निकलें, रास्ते के अंडरपास में अक्सर पानी भरता है।`) });
    }
    if (a && a.aqi > 200) {
      out.push({ key: "aqi", level: "warn", act: T("Cabin air: recirculate + purifier (demo)", "Cabin air: recirculate + purifier (demo)", "केबिन हवा: रीसर्कुलेट + प्यूरीफ़ायर (डेमो)"),
        text: T(`Air quality is ${a.band}, AQI ${a.aqi}. Windows up; I have switched the cabin to recirculation with the air purifier.`, `Hawa ${a.band} hai, AQI ${a.aqi}. Khidkiyan band rakhiye, maine cabin air recirculation aur purifier on kar diya hai.`, `हवा ${a.band} है, AQI ${a.aqi}। खिड़कियाँ बंद रखें, मैंने केबिन हवा रीसर्कुलेशन और प्यूरीफ़ायर चालू कर दिया है।`) });
    }
    if (Number.isFinite(env.tempC) && env.tempC >= 38) {
      out.push({ key: "heat", level: "info", act: T("Pre-cool from the app", "App se pre-cool", "ऐप से पहले ठंडा करें"),
        text: T(`It is ${Math.round(env.tempC)}°C outside. Next time, pre-cool the cabin from the Bluelink app before you get in.`, `Bahar ${Math.round(env.tempC)} degree hai. Agli baar baithne se pehle Bluelink app se cabin thanda kar lijiye.`, `बाहर ${Math.round(env.tempC)} डिग्री है। अगली बार बैठने से पहले Bluelink ऐप से केबिन ठंडा कर लें।`) });
    }
    return out;
  }

  // Live data for a point. Resolves to env, or null when offline: the app then simply shows nothing.
  async function fetchEnv(lat, lon, deps = {}) {
    const get = deps.fetch || fetch.bind(globalThis);
    const q = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&timezone=Asia%2FKolkata`;
    const timed = (url) => Promise.race([get(url).then((r) => (r.ok ? r.json() : null)), new Promise((r) => setTimeout(() => r(null), 6000))]).catch(() => null);
    const [w, air] = await Promise.all([
      timed(`https://api.open-meteo.com/v1/forecast?${q}&current=temperature_2m,precipitation,weather_code,visibility&hourly=precipitation_probability&forecast_hours=2`),
      timed(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&current=pm2_5,pm10`),
    ]);
    if (!w && !air) return null;
    const c = w?.current || {}, ac = air?.current || {};
    return { tempC: c.temperature_2m, code: c.weather_code, rainMm: c.precipitation, visibilityM: c.visibility,
      rainProbNext2h: Math.max(0, ...((w?.hourly?.precipitation_probability || []).filter(Number.isFinite))), pm25: ac.pm2_5, pm10: ac.pm10 };
  }

  return { indiaAqi, SKY, advise, fetchEnv };
});
