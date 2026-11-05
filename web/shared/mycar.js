// Sadak Sense "My car": the part only the carmaker can do. Map apps know the road; the car knows
// its own model, how many people are on board and every hit it has taken. Breaker advice is a
// gentle, load-aware speed suggestion (no height or depth claims); road wear feeds service and
// claims. Pure functions, shared by the driver app and the tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SadakCar = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Approximate published ground clearance (unladen); in a production car it comes from the VIN.
  const CARS = {
    aura:  { name: "Aura",  clearanceMm: 165 },
    exter: { name: "Exter", clearanceMm: 185 },
    venue: { name: "Venue", clearanceMm: 195 },
    creta: { name: "Creta", clearanceMm: 190 },
    bayon: { name: "Bayon", clearanceMm: 190, assumed: true },
  };
  const SAG_PER_PASSENGER_MM = 6;  // suspension squat for each person beyond the driver (model)
  const LOW_SITTING_MM = 160;      // below this laden clearance, suggest a gentler crossing
  const HARD_SEVERITY = 1.2;       // fleet median jolt (normalised to 30 km/h) that counts as a hard breaker

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  function effectiveClearanceMm(car, people = 1) { return car.clearanceMm - SAG_PER_PASSENGER_MM * clamp(people - 1, 0, 6); }

  // Advice for one hazard and one car. Breakers: base 20 km/h, slower if the fleet felt it hard,
  // slower again if this car sits low with its current load. Water gets no car verdict.
  function check(carId, people, h) {
    const car = CARS[carId] || CARS.creta;
    const eff = effectiveClearanceMm(car, people);
    if (h.type === "water" || h.family === "water") return { kind: "water", level: "info", car, people, devices: h.devices };
    if (h.type === "breaker") {
      const hard = (h.severity ?? 1) >= HARD_SEVERITY, low = eff < LOW_SITTING_MM;
      const speed = 20 - (hard ? 5 : 0) - (low ? 5 : 0);
      return { kind: "breaker", level: speed <= 10 ? "high" : speed <= 15 ? "medium" : "low", hard, low, effMm: eff, speed, car, people };
    }
    return { kind: "pothole", level: (h.severity ?? 1) > 1.3 ? "high" : "medium", effMm: eff, speed: 20, car, people };
  }

  // One short line for the car strip / voice, in the driver's language.
  function line(v, lang = "English") {
    const n = v.car.name, p = v.people;
    if (v.kind === "water") return { English: `Cars are crawling and stalling here. Better to take another road.`, Hinglish: `Yahan gaadiyan atak rahi hain. Doosra raasta behtar hai.`, Hindi: `यहाँ गाड़ियाँ अटक रही हैं। दूसरा रास्ता बेहतर है।` }[lang];
    if (v.kind === "breaker") {
      const hard = v.hard ? { English: "Cars feel this breaker hard. ", Hinglish: "Is breaker pe gaadiyon ko zor ka jhatka lagta hai. ", Hindi: "इस ब्रेकर पर गाड़ियों को ज़ोर का झटका लगता है। " }[lang] : "";
      if (v.low) return { English: `${hard}With ${p} on board your ${n} sits lower: slow to ${v.speed}.`, Hinglish: `${hard}${p} logon ke saath aapki ${n} neeche baithi hai: ${v.speed} tak dheere kijiye.`, Hindi: `${hard}${p} लोगों के साथ आपकी ${n} नीचे बैठी है: ${v.speed} तक धीमे करें।` }[lang];
      return { English: `${hard}Your ${n}: cross at ${v.speed}.`, Hinglish: `${hard}Aapki ${n}: ${v.speed} pe nikaliye.`, Hindi: `${hard}आपकी ${n}: ${v.speed} पर निकालें।` }[lang];
    }
    return v.level === "high"
      ? { English: `Deep pothole. Risky for your ${n}'s tyres and rims.`, Hinglish: `Gehra gaddha. Aapki ${n} ke tyre aur rim ke liye risky.`, Hindi: `गहरा गड्ढा। आपकी ${n} के टायर और रिम के लिए जोखिम।` }[lang]
      : { English: `Pothole. Slow down to protect your ${n}'s suspension.`, Hinglish: `Gaddha hai. ${n} ke suspension ke liye dheere chaliye.`, Hindi: `गड्ढा है। ${n} के सस्पेंशन के लिए धीरे चलें।` }[lang];
  }

  // Road-wear dose: how hard this car has been hit. Feeds the service and claim features.
  function wear(hits, thresholdDose = 300) {
    const dose = hits.reduce((s, h) => s + Math.max(0, (h.peakG ?? 0.6) - 0.3) * 10, 0);
    const pct = Math.round(Math.min(100, (100 * dose) / thresholdDose));
    return { hits: hits.length, dose: Math.round(dose), pct, due: pct >= 80 };
  }

  return { CARS, effectiveClearanceMm, check, line, wear };
});
