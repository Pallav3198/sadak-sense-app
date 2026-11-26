// Co-pilot logic: pure functions on real data (calendar, traffic route, Sadak Sense hazards, weather).
// Honest numbers only: each adjustment is listed so the driver can see why the time is what it is.
const MIN = 60e3;

// Extra seconds a confirmed hazard costs when driven safely (slow down, cross, speed back up).
const HAZARD_COST_S = { breaker: 8, pothole: 6, water: 240 };

function leaveBy({ event, route, hazards = [], raining = false, parkingMin = 5, now = Date.now() }) {
  const parts = [{ what: "drive with live traffic", min: Math.round(route.durationS / 60) }];
  const hz = hazards.reduce((s, h) => s + (HAZARD_COST_S[h.type] || 0), 0);
  if (hz >= 30) parts.push({ what: `${hazards.length} road hazards on the way`, min: Math.round(hz / 60) || 1 });
  if (raining) parts.push({ what: "rain (roads 15% slower)", min: Math.max(2, Math.round((route.durationS * 0.15) / 60)) });
  parts.push({ what: "parking and walking in", min: parkingMin });
  const totalMin = parts.reduce((s, p) => s + p.min, 0);
  const leave = event.start - totalMin * MIN;
  const arrive = now + (totalMin - parkingMin) * MIN;
  return { leave, totalMin, parts, late: now > leave ? Math.round((arrive + parkingMin * MIN - event.start) / MIN) : 0, arriveIfNow: arrive };
}

const hhmm = (ts) => new Date(ts).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).replace(/\s?(am|pm)/i, (m) => " " + m.trim().toLowerCase());

// Short, natural, honest: says it came from the car, gives the real ETA, nothing more.
function lateMessage({ event, arrival, name }) {
  const mins = Math.max(1, Math.round((arrival - event.start) / MIN));
  return {
    subject: `Running ${mins} min late: ${event.title}`,
    body: `Hi, I'm on my way to "${event.title}" and running about ${mins} minutes late. I should reach by ${hhmm(arrival)}.\n\n${name ? name + "\n" : ""}(sent from my car with Sadak Sense, live-traffic ETA)`,
    short: `Running about ${mins} min late, reaching by ${hhmm(arrival)} (live-traffic ETA, sent from my car).`,
  };
}

// The next event worth driving to: has a place, starts within the window, not online-only.
function nextTrip(events, now = Date.now(), withinH = 12) {
  return events.filter((e) => e.location && !e.online && e.start > now - 15 * MIN && e.start < now + withinH * 3600e3).sort((a, b) => a.start - b.start)[0] || null;
}

// Car is stopped long enough to read something out (red light, jam, parked). Never while moving.
function isStopped(samples, now = Date.now(), forMs = 6000) {
  const recent = samples.filter((s) => now - s.ts <= forMs + 1500);
  return recent.length >= 3 && now - recent[0].ts >= forMs - 500 && recent.every((s) => s.kmh < 3);
}

module.exports = { leaveBy, lateMessage, nextTrip, isStopped, hhmm, HAZARD_COST_S };
