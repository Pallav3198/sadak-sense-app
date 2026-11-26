// Context co-pilot knowledge (spec 14.6): a small knowledge graph over the owner's own Gmail threads, Teams
// chats, calendar meetings, people and places, rebuilt from the accounts on demand (nothing stored on disk).
// It answers: what does this message refer to, and what context should the driver hear with it?
const STOP = new Set("the a an and or of to for in on at is are be by with from re fw fwd your you we our this that it please hi hello meeting call sync update today tomorrow ko ka ki ke hai".split(" "));
const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const keyOf = (p) => (p.email || p.name || "").toLowerCase().trim();
const hm = (ts) => new Date(ts).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });

function buildGraph({ events = [], items = [], history = {}, now = Date.now() }) {
  const nodes = new Map(), edges = [];
  const node = (id, kind, label, extra = {}) => { if (!nodes.has(id)) nodes.set(id, { id, kind, label, ...extra }); return nodes.get(id); };
  const edge = (from, to, rel) => { if (!edges.some((e) => e.from === from && e.to === to && e.rel === rel)) edges.push({ from, to, rel }); };
  for (const e of events) {
    const m = node(`meeting:${e.id}`, "meeting", e.title, { start: e.start, location: e.location, online: e.online, joinUrl: e.joinUrl || null, organizer: e.organizer || null, source: e.source });
    if (e.location) { const pl = node(`place:${e.location.toLowerCase()}`, "place", e.location); edge(m.id, pl.id, "at"); }
    for (const a of e.attendees || []) { const p = node(`person:${keyOf(a)}`, "person", a.name || a.email, { email: a.email }); edge(p.id, m.id, "attends"); }
    if (e.organizer) { const p = node(`person:${e.organizer.toLowerCase()}`, "person", e.organizer, { email: e.organizer }); edge(p.id, m.id, "organises"); }
  }
  for (const it of items) {
    const conv = it.source === "teams" ? node(`chat:${it.chatId}`, "chat", it.subject) : node(`thread:${it.threadId || it.id}`, "thread", it.subject);
    const p = node(`person:${keyOf({ email: it.fromAddr, name: it.from })}`, "person", it.from, { email: it.fromAddr || null });
    edge(p.id, conv.id, "wrote");
    for (const h of history[conv.id] || []) { const q = node(`person:${keyOf({ email: h.fromAddr, name: h.from })}`, "person", h.from, { email: h.fromAddr || null }); edge(q.id, conv.id, "wrote"); }
    // What does this conversation refer to? A meeting the sender is in, sharing words with it or soon.
    const w = new Set(words(`${it.subject} ${it.snippet} ${(history[conv.id] || []).map((h) => h.subject + " " + h.snippet).join(" ")}`));
    for (const e of events) {
      const inIt = (e.attendees || []).some((a) => keyOf(a) === keyOf({ email: it.fromAddr, name: it.from }) || (a.name && it.from && a.name.toLowerCase() === it.from.toLowerCase())) || (e.organizer && it.fromAddr && e.organizer.toLowerCase() === it.fromAddr.toLowerCase());
      const shared = words(e.title).filter((x) => w.has(x)).length;
      const soon = e.start - now < 24 * 3600e3 && e.start - now > -2 * 3600e3;
      if ((inIt && (shared || soon)) || shared >= 2) edge(conv.id, `meeting:${e.id}`, "about");
    }
  }
  return { nodes: [...nodes.values()], edges, builtAt: now };
}

// The context for one message: what it refers to and the line to say with it.
function contextFor(item, graph, { trip = null, history = {}, now = Date.now() } = {}) {
  const conv = item.source === "teams" ? `chat:${item.chatId}` : `thread:${item.threadId || item.id}`;
  const about = graph.edges.filter((e) => e.from === conv && e.rel === "about").map((e) => graph.nodes.find((n) => n.id === e.to)).filter(Boolean).sort((a, b) => a.start - b.start)[0] || null;
  const earlier = (history[conv] || []).filter((h) => (h.from || "").toLowerCase() === (item.from || "").toLowerCase() && now - h.ts < 864e5).length;
  const name = (item.from || "Someone").split(" ")[0];
  const driving = about && trip && trip.destination && about.location && (about.location.toLowerCase().includes(trip.destination.toLowerCase().split(",")[0]) || trip.destination.toLowerCase().includes(about.location.toLowerCase().split(",")[0]));
  let line = "";
  if (about) {
    line = `${name}${earlier ? " again" : ""} about ${about.label}${driving ? `, the meeting you're driving to at ${hm(about.start)}${trip.minutes_left != null ? `; you're ${trip.minutes_left} min away` : ""}` : ` at ${hm(about.start)}`}.`;
  } else if (earlier) {
    line = `${name} again in "${item.subject}" (${earlier + 1} messages today).`;
  }
  return { refersTo: about ? { kind: "meeting", id: about.id, title: about.label, start: about.start, location: about.location || null } : earlier ? { kind: "thread", id: conv, title: item.subject } : null, context: line };
}

// Next online call (Teams / Meet) starting within 20 minutes, or started up to 10 minutes ago.
function nextCall(events, now = Date.now()) {
  return events.filter((e) => e.joinUrl && e.start - now < 20 * 60e3 && now - e.start < 10 * 60e3).sort((a, b) => a.start - b.start)[0] || null;
}

module.exports = { buildGraph, contextFor, nextCall, words, hm };
