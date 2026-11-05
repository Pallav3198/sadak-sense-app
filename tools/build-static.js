// Builds the shareable static edition (no server): console + driver app with the backend
// running in the browser and map tiles bundled. Output: <outDir>/index.html, drive.html.
// Usage: node tools/build-static.js ../sadak-sense-site [--full-doc] [--osm-tiles]
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const out = path.resolve(process.argv[2] || path.join(root, "dist"));
const fullDocIndex = process.argv.includes("--full-doc");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8");
const LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
const leafletCss = fs.readFileSync(path.join(root, "node_modules/leaflet/dist/leaflet.css"), "utf8").replace(/url\(images\/[^)]+\)/g, "none");
const ui = rd("web/shared/ui.css");
const routes = rd("sim/routes.json");
const wrap = (name, src, pre = "") => `def(${JSON.stringify(name)}, function (module, exports, require) { ${pre}\n${src}\n});`;
const mods = `<script>
window.SSMods = (function () {
  const mods = {}; const ROUTES = ${routes};
  mods["./routes.json"] = ROUTES;
  function def(name, fn) { const module = { exports: {} }; fn(module, module.exports, (n) => mods[n]); mods[name] = module.exports; }
  ${wrap("geo", rd("server/geo.js"))}
  mods["../server/geo"] = mods.geo; mods["./geo"] = mods.geo;
  ${wrap("fleet", rd("sim/fleet.js"))}
  ${wrap("brief", rd("server/brief.js"), "const process = { env: {} };")}
  return { geo: mods.geo, fleet: mods.fleet, brief: mods.brief, routes: ROUTES };
})();
</script>`;
// --osm-tiles keeps OpenStreetMap's live tiles (the GitHub Pages demo); otherwise tiles are bundled.
const osmTiles = process.argv.includes("--osm-tiles");
const common = osmTiles ? rd("web/shared/common.js") : rd("web/shared/common.js").replace(
  /L\.tileLayer\("https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png", \{\s*maxZoom: 19,/,
  'L.tileLayer("tiles/{z}/{x}/{y}.png", { minZoom: 12, maxZoom: 18, maxNativeZoom: 16,'
);
const script = (s) => `<script>\n${s}\n</script>`;

function page(htmlPath, extraScripts, { contentOnly, title }) {
  let h = rd(htmlPath);
  h = h.replace(/<link rel="stylesheet" href="\/vendor\/leaflet\/leaflet.css">/, `<style>${leafletCss}</style>`)
    .replace(/<link rel="stylesheet" href="\/shared\/ui.css">/, `<style>${ui}</style>`)
    .replace(/<link rel="manifest"[^>]*>/, "")
    .replace(/<script src="\/vendor\/leaflet\/leaflet.js"><\/script>/, `<script src="${LEAFLET_JS}"></script>`)
    .replace(/<script src="\/shared\/common.js"><\/script>/, script(common))
    .replace(/<script src="\/shared\/detector.js"><\/script>/, script(rd("web/shared/detector.js")))
    .replace(/<script src="\/shared\/hinglish.js"><\/script>/, "")
    .replace(/<script src="\/shared\/mycar.js"><\/script>/, script(rd("web/shared/mycar.js")))
    .replace(/<script src="\/shared\/voice.js"><\/script>/, script(rd("web/shared/voice.js")))
    .replace(/<script src="\/shared\/mail.js"><\/script>/, script(rd("web/shared/mail.js")))
    .replace(/<script src="\/console\/console.js"><\/script>/, script(rd("web/console/console.js")))
    .replace(/<script src="\/drive\/drive.js"><\/script>/, script(rd("web/drive/drive.js")))
    .replace('href="/drive/" target="_blank" rel="noopener"', 'href="drive.html"')
    .replace('<a href="/drive/"', '<a href="drive.html"');
  // backend shim must load before the app scripts (it patches fetch and EventSource)
  const shim = script(rd("web/shared/hinglish.js")) + "\n" + mods + "\n" + script(rd("web/shared/local-backend.js"));
  h = h.replace(`<script src="${LEAFLET_JS}"></script>`, `<script src="${LEAFLET_JS}"></script>\n${shim}`);
  if (title) h = h.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  if (contentOnly) {
    h = h.replace(/<!doctype html>\s*/i, "").replace(/<html[^>]*>\s*/i, "").replace(/<\/html>\s*$/i, "")
      .replace(/<head>\s*/i, "").replace(/<\/head>\s*/i, "").replace(/<body>\s*/i, "").replace(/<\/body>\s*/i, "")
      .replace(/<meta charset="utf-8">/i, "").replace(/<meta name="viewport"[^>]*>/i, "");
  }
  return h;
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), page("web/console/index.html", [], { contentOnly: !fullDocIndex, title: "Sadak Sense Console" }));
fs.writeFileSync(path.join(out, "drive.html"), page("web/drive/index.html", [], { contentOnly: false, title: "Sadak Sense Drive" }));
console.log("built", out);
