// Drive-aware delivery in the app (spec 14.4). Decides WHEN and HOW MUCH the co-pilot may say:
//   red > 40 s or parked → full message with reply (and a short Teams call for Teams contacts)
//   red 15–40 s          → one-line summaries          red < 15 s → nothing
//   clear road           → one-line summaries          busy (turns, braking, hazard ahead) → nothing
//   traffic jam          → hold and batch; only VIP / urgent one-liners, and only while fully stopped
// Each stop at a signal is reported (anonymously) so the fleet learns stop lines and red lengths.
const MomentUI = (() => {
  const MO = SadakMoment.createMoment();
  const st = { cur: { kind: "busy" }, signal: null, stopKey: null, stopStart: null, lastHeading: null, lastLine: 0, held: [], later: [], wasJam: false, sim: null };
  const vips = () => { try { return JSON.parse(localStorage.getItem("ss-vip") || "[]"); } catch { return []; } };
  const label = (c) => c.kind === "red" ? `Red light · ~${c.secondsLeft} s${c.learned ? "" : " (est.)"}` : c.kind === "jam" ? `Traffic${st.held.length ? ` · ${st.held.length} held` : ""}` : c.kind === "parked" ? "Parked" : c.kind === "clear" ? "Clear road" : "Driving";

  async function onStopStart(now) {
    const p = S.pos; if (!p) return;
    st.stopKey = `${S.device}-${now}`; st.stopStart = now; st.signal = null;
    try { st.signal = await SS.api(`/api/signals/state?lat=${p.lat}&lon=${p.lon}&heading=${st.lastHeading ?? ""}`); } catch {}
    if (st.signal?.signal) SS.api("/api/stops", { action: "start", key: st.stopKey, device: S.device, signalId: st.signal.signal.id, heading: st.lastHeading, lat: p.lat, lon: p.lon, start: now }).catch(() => {});
  }
  function onStopEnd(now, prev) {
    const p = S.pos; if (!p || !st.stopKey) return;
    const kind = prev.kind === "red" ? "signal" : prev.kind === "jam" ? "jam" : "other";
    if (kind !== "other") SS.api("/api/stops", { action: "end", key: st.stopKey, device: S.device, signalId: st.signal?.signal?.id || null, heading: st.lastHeading, lat: p.lat, lon: p.lon, start: st.stopStart, end: now, front: !!prev.front, kind }).catch(() => {});
    st.stopKey = null; st.signal = null;
  }

  function tick() {
    if (!S.mode || !S.pos) return;
    const now = Date.now(), kmh = (S.pos.speed || 0) * 3.6;
    if (kmh >= 5 && S.pos.heading != null) st.lastHeading = S.pos.heading;
    MO.sample({ ts: now, kmh, heading: S.pos.heading, lat: S.pos.lat, lon: S.pos.lon });
    const hazardAhead = !$("alert").className.includes("clear");
    const prev = st.cur;
    let cur = st.sim ? st.sim() : MO.state({ now, signal: st.signal, hazardAhead });
    if (!st.sim) {
      const stoppedNow = ["red", "jam", "parked"].includes(cur.kind) || (MO.samples.slice(-2).every((s) => s.kmh < 3) && MO.samples.length > 2);
      if (stoppedNow && !st.stopKey) onStopStart(now);
      if (!stoppedNow && st.stopKey) onStopEnd(now, prev);
    }
    st.cur = cur; $("cMoment").textContent = label(cur); $("cMoment").className = "chip " + (cur.kind === "busy" ? "" : cur.kind === "jam" ? "bad" : "ok");
    deliver(cur, prev);
  }

  function line(it, why) {
    openConvo(); const src = it.source === "teams" ? "Teams" : "Gmail";
    bubble("a", `${src} · ${why}`, `${it.from}: ${it.subject}`);
    say(coT(`${it.from}: ${it.subject}.`, `${it.from}: ${it.subject}.`, `${it.from}: ${it.subject}।`), "info");
    st.later.push(it); st.lastLine = Date.now();
  }
  function batch(items) {
    openConvo();
    const list = items.slice(0, 4).map((i) => `${i.from} (${i.subject})`).join(", ");
    const more = items.length > 4 ? coT(` and ${items.length - 4} more`, ` aur ${items.length - 4} aur`, ` और ${items.length - 4} और`) : "";
    const l = coT(`While you were in traffic: ${items.length} new. ${list}${more}.`, `Traffic ke dauraan ${items.length} naye message: ${list}${more}.`, `ट्रैफ़िक के दौरान ${items.length} नए संदेश: ${list}${more}।`);
    bubble("a", "Sadak Sense · held in traffic", l); say(l, "info");
    st.later.push(...items);
  }
  function full(it) {
    const where = it.source === "teams" ? "Teams message" : "mail";
    openConvo(); bubble("a", it.source === "teams" ? "Teams" : "Gmail", `${it.from}: ${it.subject}\n${it.snippet}`);
    if (it.callUrl) { const a = document.createElement("a"); a.href = it.callUrl; a.target = "_blank"; a.rel = "noopener"; a.className = "btn"; a.textContent = coT(`Short call to ${it.from} on Teams`, `${it.from} ko Teams pe chhoti call`, `${it.from} को टीम्स पर छोटी कॉल`); a.style.cssText = "display:block;text-align:center;margin:4px 0"; $("msgs").append(a); }
    coAsk("reply?", it, (it.context ? it.context + " " : "") + coT(`New ${where} from ${it.from}: ${it.subject}. ${it.snippet}. Reply?`, `${it.from} ka naya ${where}: ${it.subject}. ${it.snippet}. Jawab dena hai?`, `${it.from} का नया ${where === "mail" ? "मेल" : "टीम्स मैसेज"}: ${it.subject}। ${it.snippet}। जवाब देना है?`));
  }
  const take = (list, pred = () => true) => { const i = list.findIndex(pred); return i < 0 ? null : list.splice(i, 1)[0]; };
  const mark = (it) => { CO.seen.add(it.source + it.id); keepSeen(); };
  // 14.5 schedule: some items wait for the right time of day (e.g. work mail in the evening); VIP/urgent pass.
  const waits = (it) => (window.Commute ? Commute.holds(it) : false) && !SadakMoment.isVip(it, vips()) && !SadakMoment.isUrgent(it);

  function deliver(cur, prev) {
    if (!CO.me?.owner && !st.demoItems) return;
    const t = st.sim ? cur.tier : MO.tier(cur);
    // A conversation in progress pauses when driving gets busy; it continues at the next good moment.
    const green = cur.kind === "red" && t === "none";
    if (CO.step && CO.step !== "late" && (green || ((t === "none" || t === "line") && cur.kind !== "red"))) {
      const it = CO.item; CO.step = null; $("yn").hidden = true; if (it && it.id) st.later.unshift(it);
      const l = green ? coT("Light's about to turn green. I'll continue at the next stop.", "Batti hari hone wali hai. Agle stop pe baaki bataunga.", "बत्ती हरी होने वाली है। अगले स्टॉप पर बाक़ी बताऊँगा।")
        : coT("Moving again. I'll continue at the next stop.", "Gaadi chal padi. Agle stop pe baaki bataunga.", "गाड़ी चल पड़ी। अगले स्टॉप पर बाक़ी बताऊँगा।");
      bubble("a", "Sadak Sense", l); say(l, "info"); return;
    }
    if (CO.step || S.pendingAgent || S.pendingJolt) return;
    const inbox = CO.inbox.filter((it) => !waits(it));
    if (cur.kind === "jam") {
      st.wasJam = true;
      // hold and batch everything except VIP / urgent, which may be said in one line while fully stopped
      for (const it of inbox.splice(0)) { CO.inbox.splice(CO.inbox.indexOf(it), 1); mark(it); (SadakMoment.isVip(it, vips()) || SadakMoment.isUrgent(it) ? st.vipQueue || (st.vipQueue = []) : st.held).push(it); }
      const v = st.vipQueue?.shift(); if (v && Date.now() - st.lastLine > 8000) line(v, coT("important", "zaroori", "ज़रूरी"));
      $("coInbox").textContent = st.held.length ? `${st.held.length} held in traffic` : "";
      return;
    }
    if (t === "none") return;
    if (st.held.length && (t === "line" || t === "full")) { batch(st.held.splice(0)); st.wasJam = false; return; }
    if (t === "line") {
      const gap = cur.kind === "red" ? 6000 : 45000; // red 15–40 s: up to a couple of lines; clear road: one a minute or so
      if (Date.now() - st.lastLine < gap) return;
      const it = take(CO.inbox, (x) => inbox.includes(x)); if (it) { mark(it); line(it, cur.kind === "red" ? coT("red light", "red light", "लाल बत्ती") : coT("clear road", "saaf raasta", "साफ़ रास्ता")); }
      return;
    }
    if (t === "full") {
      const it = st.later.shift() || take(CO.inbox, (x) => inbox.includes(x)); if (!it) return;
      mark(it); full(it);
    }
  }

  // Demo (Simulate): a red-light countdown and a traffic jam, with labelled sample messages if no account is connected.
  function simulate(kind, seconds, shown = seconds) {
    const end = Date.now() + seconds * 1000;
    st.sim = kind === "red" ? () => { const left = Math.max(0, Math.round(((end - Date.now()) / (seconds * 1000)) * shown)); return { kind: "red", secondsLeft: left, learned: true, tier: left > 40 ? "full" : left >= 15 ? "line" : "none" }; }
      : kind === "jam" ? () => ({ kind: "jam", tier: "vip-line" }) : kind === "clear" ? () => ({ kind: "clear", tier: "line" }) : null;
    return new Promise((r) => setTimeout(() => { st.sim = null; r(); }, seconds * 1000));
  }
  function demoItems(items) { st.demoItems = true; CO.inbox.push(...items); }
  return { tick, simulate, demoItems, get state() { return st.cur; }, get held() { return st.held; }, MO };
})();
setInterval(() => { try { MomentUI.tick(); } catch (e) { console.warn("moment", e); } }, 1000);
