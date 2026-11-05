// Sadak Sense home updates by email, through EmailJS's free plan, because a static page has no server
// to send from. These three values are public by design and safe in the page. With them empty, the
// app stays in demo mode and sends nothing. In a car this would go through the connected-car cloud.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SadakMail = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const CONFIG = { serviceId: "", templateId: "", publicKey: "" };
  const ENDPOINT = "https://api.emailjs.com/api/v1.0/email/send";
  const DAILY_LIMIT = 20; // per browser, so one visitor cannot use up the free allowance

  const configured = (c = CONFIG) => !!(c.serviceId && c.templateId && c.publicKey);
  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || "").trim());

  function underLimit(store, today) {
    try {
      const u = JSON.parse(store.getItem("ss-mail") || "{}");
      const n = u.day === today ? u.n : 0;
      if (n >= DAILY_LIMIT) return false;
      store.setItem("ss-mail", JSON.stringify({ day: today, n: n + 1 }));
    } catch {}
    return true;
  }

  // Resolves to { ok: true } or { ok: false, why: "off" | "address" | "limit" | "failed" }. Never throws.
  async function send({ to, subject, message }, deps = {}) {
    const c = deps.config || CONFIG, post = deps.fetch || fetch.bind(globalThis);
    if (!configured(c)) return { ok: false, why: "off" };
    if (!validEmail(to)) return { ok: false, why: "address" };
    const store = deps.store || (typeof localStorage !== "undefined" ? localStorage : null);
    if (store && !underLimit(store, new Date().toISOString().slice(0, 10))) return { ok: false, why: "limit" };
    try {
      const res = await post(ENDPOINT, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ service_id: c.serviceId, template_id: c.templateId, user_id: c.publicKey, template_params: { to_email: String(to).trim(), subject, message } }),
      });
      return res.ok ? { ok: true } : { ok: false, why: "failed" };
    } catch { return { ok: false, why: "failed" }; }
  }

  return { CONFIG, DAILY_LIMIT, configured, validEmail, send };
});
