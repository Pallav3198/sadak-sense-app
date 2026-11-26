// The owner's own accounts, read and written with their permission (OAuth, delegated):
//   Google: Gmail (read, send) and Calendar (read).   Microsoft: Teams chats (read, send) and Outlook calendar (read).
// Refresh tokens are never stored on the server: they travel back from the phone in sealed cookies.
const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/calendar.readonly"];
const MS_SCOPES = ["offline_access", "User.Read", "User.ReadBasic.All", "Chat.Read", "ChatMessage.Send", "Calendars.Read"];

const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null)).toString();
const strip = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const nameOf = (from) => String(from || "").replace(/<.*>/, "").replace(/"/g, "").trim() || String(from || "");
const addrOf = (from) => (String(from || "").match(/<([^>]+)>/) || [, from])[1];

function createAccounts({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const g = { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
  const ms = { id: env.MS_CLIENT_ID, secret: env.MS_CLIENT_SECRET, tenant: env.MS_TENANT || "organizations" };
  const access = new Map(); // refresh token -> { token, exp } (memory only; rebuilt after a restart)

  async function j(url, init = {}) {
    const r = await fetchImpl(url, init);
    const b = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(b.error_description || b.error?.message || (typeof b.error === "string" ? b.error : "") || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return b;
  }

  /* ---------- Google ---------- */
  const google = {
    on: !!(g.id && g.secret),
    authUrl: (redirect, state) => "https://accounts.google.com/o/oauth2/v2/auth?" + form({ client_id: g.id, redirect_uri: redirect, response_type: "code", scope: GOOGLE_SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state }),
    async exchange(code, redirect) {
      const t = await j("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ code, client_id: g.id, client_secret: g.secret, redirect_uri: redirect, grant_type: "authorization_code" }) });
      const me = await j("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${t.access_token}` } });
      if (t.refresh_token) access.set(t.refresh_token, { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 });
      return { email: me.email_verified === false ? null : me.email, refresh: t.refresh_token };
    },
    async token(refresh) {
      const c = access.get(refresh); if (c && c.exp > Date.now()) return c.token;
      const t = await j("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ refresh_token: refresh, client_id: g.id, client_secret: g.secret, grant_type: "refresh_token" }) });
      access.set(refresh, { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 }); return t.access_token;
    },
    async api(refresh, url, init = {}) { const tk = await google.token(refresh); return j(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${tk}` } }); },

    // Important unread mail from the last day (Gmail's Primary tab, not promotions or social).
    async unread(refresh, max = 5) {
      const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
      const list = await google.api(refresh, `${base}?` + form({ q: "is:unread category:primary newer_than:1d", maxResults: max }));
      const out = [];
      for (const m of list.messages || []) {
        const d = await google.api(refresh, `${base}/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`);
        const h = Object.fromEntries((d.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
        out.push({ source: "gmail", id: d.id, threadId: d.threadId, from: nameOf(h.from), fromAddr: addrOf(h.from), subject: h.subject || "(no subject)", snippet: strip(d.snippet).slice(0, 220), messageId: h["message-id"] || null, ts: +d.internalDate || Date.now() });
      }
      return out;
    },
    async send(refresh, { to, subject, body, threadId, inReplyTo }) {
      const head = [`To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit"];
      if (inReplyTo) head.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
      const raw = Buffer.from(head.join("\r\n") + "\r\n\r\n" + body, "utf8").toString("base64url");
      const r = await google.api(refresh, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(threadId ? { raw, threadId } : { raw }) });
      return { id: r.id };
    },
    async events(refresh, now = Date.now(), hours = 14) {
      const r = await google.api(refresh, "https://www.googleapis.com/calendar/v3/calendars/primary/events?" + form({ timeMin: new Date(now).toISOString(), timeMax: new Date(now + hours * 3600e3).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: 10 }));
      return (r.items || []).filter((e) => e.start?.dateTime && e.status !== "cancelled").map((e) => ({
        source: "google", id: e.id, title: e.summary || "Meeting", location: e.location || "", start: Date.parse(e.start.dateTime), online: !!e.hangoutLink && !e.location,
        attendees: (e.attendees || []).filter((a) => !a.self && a.email && !a.resource).map((a) => ({ email: a.email, name: a.displayName || a.email })),
      }));
    },
  };

  /* ---------- Microsoft (Teams, Outlook calendar) ---------- */
  const msBase = `https://login.microsoftonline.com/${ms.tenant}/oauth2/v2.0`;
  const microsoft = {
    on: !!(ms.id && ms.secret),
    authUrl: (redirect, state) => `${msBase}/authorize?` + form({ client_id: ms.id, response_type: "code", redirect_uri: redirect, response_mode: "query", scope: MS_SCOPES.join(" "), state, prompt: "select_account" }),
    async exchange(code, redirect) {
      const t = await j(`${msBase}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ client_id: ms.id, client_secret: ms.secret, code, redirect_uri: redirect, grant_type: "authorization_code", scope: MS_SCOPES.join(" ") }) });
      access.set(t.refresh_token, { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 });
      const me = await j("https://graph.microsoft.com/v1.0/me", { headers: { authorization: `Bearer ${t.access_token}` } });
      return { email: me.mail || me.userPrincipalName, name: me.displayName, userId: me.id, refresh: t.refresh_token };
    },
    // Microsoft rotates refresh tokens: callers must store the new one (rotated) back in the cookie.
    async token(refresh) {
      const c = access.get(refresh); if (c && c.exp > Date.now()) return { token: c.token, rotated: null };
      const t = await j(`${msBase}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ client_id: ms.id, client_secret: ms.secret, refresh_token: refresh, grant_type: "refresh_token", scope: MS_SCOPES.join(" ") }) });
      const next = t.refresh_token || refresh; access.set(next, { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 });
      return { token: t.access_token, rotated: next !== refresh ? next : null };
    },
    async api(refresh, url, init = {}) {
      const { token, rotated } = await microsoft.token(refresh);
      return { data: await j(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } }), rotated };
    },
    // Teams chats whose newest message is from someone else and newer than when the owner last read the chat.
    async unread(refresh, userId, max = 5) {
      const { data, rotated } = await microsoft.api(refresh, "https://graph.microsoft.com/v1.0/me/chats?$expand=lastMessagePreview&$top=20&$orderby=lastMessagePreview/createdDateTime%20desc");
      const items = (data.value || []).map((c) => ({ c, m: c.lastMessagePreview })).filter(({ c, m }) => m && !m.isDeleted && m.from?.user && m.from.user.id !== userId
        && Date.now() - Date.parse(m.createdDateTime) < 864e5
        && (!c.viewpoint?.lastMessageReadDateTime || Date.parse(m.createdDateTime) > Date.parse(c.viewpoint.lastMessageReadDateTime)))
        .slice(0, max).map(({ c, m }) => ({ source: "teams", id: m.id, chatId: c.id, fromId: m.from.user.id, from: m.from.user.displayName || "Someone", subject: c.topic || (c.chatType === "oneOnOne" ? "Teams chat" : "Group chat"), snippet: strip(m.body?.content).slice(0, 220), ts: Date.parse(m.createdDateTime) }));
      // Sender's address, so the driver can make a short Teams call when parked or at a long red (14.4).
      for (const it of items) {
        try {
          const u = (await microsoft.api(refresh, `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(it.fromId)}?$select=mail,userPrincipalName`)).data;
          it.fromAddr = u.mail || u.userPrincipalName || null;
          if (it.fromAddr) it.callUrl = `https://teams.microsoft.com/l/call/0/0?users=${encodeURIComponent(it.fromAddr)}`;
        } catch {}
      }
      return { items, rotated };
    },
    async send(refresh, chatId, text) {
      const { data, rotated } = await microsoft.api(refresh, `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: { contentType: "text", content: text } }) });
      return { id: data.id, rotated };
    },
    async events(refresh, now = Date.now(), hours = 14) {
      const { data, rotated } = await microsoft.api(refresh, "https://graph.microsoft.com/v1.0/me/calendarView?" + form({ startDateTime: new Date(now).toISOString(), endDateTime: new Date(now + hours * 3600e3).toISOString(), $orderby: "start/dateTime", $top: 10 }), { headers: { Prefer: 'outlook.timezone="UTC"' } });
      const items = (data.value || []).filter((e) => !e.isCancelled).map((e) => ({
        source: "outlook", id: e.id, title: e.subject || "Meeting", location: e.location?.displayName || "", start: Date.parse(e.start.dateTime + "Z"), online: !!e.isOnlineMeeting && !e.location?.displayName,
        attendees: (e.attendees || []).filter((a) => a.emailAddress?.address).map((a) => ({ email: a.emailAddress.address, name: a.emailAddress.name || a.emailAddress.address })),
      }));
      return { items, rotated };
    },
  };

  return { google, microsoft };
}

module.exports = { createAccounts, GOOGLE_SCOPES, MS_SCOPES, strip };
