// App shell: the menu drawer (demos, car screen, settings live here), the speed ring and the home card.
(() => {
  const drawer = $("drawer"), scrim = $("scrim");
  const open = () => { drawer.hidden = false; scrim.hidden = false; };
  const close = () => { drawer.hidden = true; scrim.hidden = true; };
  $("menuBtn").onclick = open; $("menuBtn2").onclick = open; $("menuClose").onclick = close; scrim.onclick = close;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !drawer.hidden) close(); });
  // Starting a demo or opening a sheet from the menu closes it.
  for (const id of ["fullBtn", "demoBtn", "obOpen", "pairBtn"]) $(id).addEventListener("click", () => setTimeout(close, 0));
  // Once a drive runs, the demo entries go away (one drive per page load).
  document.addEventListener("ss-drive-start", () => { $("demoGroup").hidden = true; close(); });

  // Speed ring: 0–180 km/h fills the dial.
  const dev = document.querySelector(".device"), spd = $("spd");
  const ring = () => dev.style.setProperty("--sp", Math.min(100, (parseFloat(spd.textContent) || 0) / 1.8).toFixed(1));
  new MutationObserver(ring).observe(spd, { childList: true, characterData: true, subtree: true }); ring();

  // Home card shows the chosen car.
  const car = () => { const o = $("carSel").selectedOptions[0]; $("heroCar").textContent = `${o ? o.textContent : "Hyundai"} · ready`; };
  $("carSel").addEventListener("change", car); car();
})();
