# Sadak Sense

**Fleet-learned road hazard alerts for Indian roads.** Connected cars (or phones mounted in them) feel every speed breaker, pothole and flooded underpass they drive over. Sadak Sense turns those jolts into anonymous reports, confirms a hazard only when **3 different cars** agree, removes it automatically after **8 clean passes** (the road was fixed), and warns the next driver about 6 seconds ahead by chime and voice in **English, Hindi or Hinglish**.

Built for the Hyundai CoE Mobility Innovation Ideathon 2026 · Topic 2 (AI-powered & digital in-vehicle experience) · Track B.

**Live demo:** https://pallav3198.github.io/sadak-sense-app/ (driver app: [/drive.html](https://pallav3198.github.io/sadak-sense-app/drive.html)). Best in Microsoft Edge for the natural Indian voice.

---

## What's in the box

| Part | Path | What it does |
|---|---|---|
| **Driver app** (PWA) | `/drive/` | Runs on a phone in a car mount. Reads the **real accelerometer and GPS**, runs the jolt detector on the device, sends anonymous events, reports clean passes, and gives voice alerts for confirmed hazards ahead. A *Demo drive* mode feeds simulated GPS and a synthetic accelerometer signal along a real Delhi road through the same detector. |
| **Fleet console** | `/console/` | Live map of hazards (candidate → confirmed → removed), event stream, per-hazard evidence (cars, severity, pass history), morning road brief, and controls for the virtual fleet. |
| **API + engine** | `server/` | Ingests events, clusters them (20 m, direction-aware), confirms with 3 distinct devices, removes after 8 clean passes, rejects one-off false alarms, detects waterlogging from cars crawling in rain, and streams changes over Server-Sent Events. SQLite storage. |
| **On-board detector** | `web/shared/detector.js` | Gravity-projected vertical acceleration → high-pass → adaptive threshold → **axle-pair test** (a second hit `wheelbase ÷ speed` later means both axles crossed a full-width speed breaker; a single sharp dip is a pothole). Ignores phone handling and walking speeds. Same file runs in the browser and in the tests. |
| **Fleet simulator** | `sim/fleet.js` | Virtual cars drive **real road geometry** (OpenStreetMap via OSRM) around IIT Delhi, Hauz Khas, AIIMS, Saket, Vasant Vihar and Connaught Place → Minto Bridge, and post to the same API as phones. Can also load-test a deployed server from a laptop. |
| **Two-way voice** | `web/shared/hinglish.js`, `POST /api/ask` | The driver talks to the car in **English, Hindi (Devanagari) or Hinglish** and hears answers in the same register, built from live fleet data: *"Aage koi gaddha hai?"* → *"Haan. 190 metre mein gaddha hai, 46 gaadiyon ne confirm kiya."* After a jolt at an unknown spot the car asks *"Kya wo gaddha tha? Haan ya na"*; "na" drops the report. *"Yahan bada gaddha hai"* files a hands-free report. Rule-based so it works offline; the same file runs in the browser, the server and the tests. |
| **My car + agents** | `web/shared/mycar.js`, `web/drive/drive.js` | What only the carmaker can do. Breaker advice adapts gently to the car and its load (*"5 logon ke saath aapki Aura neeche baithi hai: 10 tak dheere kijiye."*); no height or depth claims. Agents act after one "haan": the **flood agent** reroutes around an underpass that cars are crawling or stalling in, the **damage agent** books a Hyundai service slot and drafts a claim after a hard hit with falling tyre pressure, and **Keep home updated** tells the family when the trip changes. A road-wear panel keeps this car's hit log for service or insurance. Tyre pressure, messages and bookings are simulated in the demo and labelled so. |
| **Natural Indian voice** | `web/shared/voice.js` | Free, no API key. Picks the most natural Indian voice the browser has (Edge: Microsoft's neural Swara, Madhur, Neerja, Prabhat; Chrome: Google Hindi; phones: their own) and respells Roman Hinglish in Devanagari so a Hindi voice pronounces it properly. The driver app has a voice picker with a "Hear this voice" button. Best in Microsoft Edge. |
| **Static edition** | `tools/build-static.js`, `web/shared/local-backend.js` | Builds a browser-only copy (engine, simulator and voice run inside the page; map tiles bundled) that can be hosted on any static host for a no-install demo. |
| **Tests** | `test/` | 33 automated tests: engine rules, detector classification and false-alarm rejection, language handling, load-aware breaker advice, road-wear thresholds, and an end-to-end API test including Hinglish questions and voice reports. |

## Run locally

Requires Node.js 22.13 or newer (uses the built-in `node:sqlite`; no native build).

```bash
npm install
npm test                 # 33 tests
AUTOSTART_SIM=true npm start
# console:     http://localhost:3000/console/
# driver app:  http://localhost:3000/drive/
```

Or with Docker: `docker compose up --build`.

## Deploy (free, about 5 minutes)

**Render (recommended):** push this folder to a GitHub repo → on render.com choose *New + → Blueprint* → select the repo. `render.yaml` builds the Docker image, runs the tests during the build, and starts the virtual fleet. You get an HTTPS URL, which phones need for motion-sensor and GPS access.

**Railway / Fly.io / any Docker host:** build the `Dockerfile`; expose port 3000; set `AUTOSTART_SIM=true` for a live demo.

Notes:
- Free tiers sleep when idle and have ephemeral disks: data resets on redeploy. Mount a volume at `/app/data` to keep it.
- Optional `ANTHROPIC_API_KEY` turns the morning brief into natural Claude-written speech; without it, templates are used.
- Map tiles come from OpenStreetMap's public servers, which are for light, attributed use. For production use the navigation partner's tile service.

## Static (no-server) edition

```bash
node tools/build-static.js ../sadak-sense-site --full-doc --osm-tiles   # writes index.html (console) + drive.html
```
Host the folder anywhere. The live demo, **https://pallav3198.github.io/sadak-sense-demo/** (driver app at `/drive.html`), is this edition on GitHub Pages with live OpenStreetMap tiles. Without `--osm-tiles`, copy a `tiles/{z}/{x}/{y}.png` folder of map tiles next to it. The fleet is simulated per viewer; for real phones on one shared map, deploy the server.

## Field test with real phones (before the final round)

1. Deploy, then open `https://<your-app>/drive/` on 3+ phones (Android Chrome or iPhone Safari). Mount each phone firmly; loose phones add noise.
2. Tap **Start driving** and allow motion and location access.
3. Drive the same 1–2 km stretch with known speed breakers and potholes, in separate cars or separate runs.
4. Watch `/console/`: hazards appear as candidates after the first car and turn solid at the third.
5. Record precision (confirmed hazards that are real) and recall (real hazards confirmed) for the deck.

## API

| Method | Path | Body / query | Purpose |
|---|---|---|---|
| `POST` | `/api/events` | `{device, lat, lon, heading, speed, peak_g, type: breaker\|pothole\|crawl, rain, ts}` or an array (offline batch, max 200) | Sensor reports |
| `POST` | `/api/passes` | `{hazardId, device, ts}` | Car crossed a known hazard and felt nothing |
| `GET` | `/api/hazards` | `lat, lon, radius, states=candidate,confirmed,cleared,rejected` | Hazards near a point |
| `GET` | `/api/hazards/:id` | | Hazard with recent pass history |
| `POST` | `/api/brief` | `{routeId \| coords, lang}` | Morning road brief for a route |
| `POST` | `/api/ask` | `{text, lat, lon, heading, device, routeId, pending, prefer}` | Two-way voice: reply in the driver's language from live data; spoken reports become events |
| `GET` | `/api/stats` | | Counters |
| `GET` | `/api/stream` | | Server-Sent Events: `hazard`, `stats`, `sim` |
| `GET/POST` | `/api/sim` | `{action: start\|stop\|repair, carsPerMin, speedup, monsoon}` | Virtual fleet controls |

## Rules the engine applies

- **Cluster:** events within 20 m (60 m for waterlogging). Potholes are direction-specific (heading within 60°); speed breakers span the road.
- **Confirm:** 3 distinct devices within 7 days (waterlogging: 3 devices crawling below 10 km/h in rain within 30 minutes).
- **Remove:** 8 consecutive clean passes (repaired). Waterlogging recedes after 2 hours with no reports.
- **Reject:** a candidate that 8 cars pass without feeling is a false alarm.
- **Severity:** median peak vertical g, normalised to 30 km/h.

## Privacy

Reports carry only location, heading, speed, jolt size and a device ID that is a hash of a local secret and the date, so it changes every day. No trip history is stored. Designed to align with India's DPDP Act. In a production car, the same events would come from the vehicle's own sensors over the connected-car link.

## How this maps to a production car

| Prototype | In a connected car |
|---|---|
| Phone accelerometer + GPS | Vehicle motion data already used for connected-car driving scores, ABS wheel speed, GPS |
| Phone camera (not used) | Dashcam / ADAS front camera to confirm a hazard visually |
| Browser voice | Head-unit voice assistant, cluster icon |
| HTTPS from the phone | Telematics unit uplink (~50 bytes per event) |
| Leaflet map | Navigation partner's map layer |

## Limits

- Hazard locations in the simulator are illustrative; the roads are real.
- Phone sensing depends on a firm mount; real detection rates need the field test above.
- Lane-level pothole position is approximate with phone GPS (±5 m).

Icons: none bundled. Map data © OpenStreetMap contributors. License: MIT.
