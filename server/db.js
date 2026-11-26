// SQLite storage using Node's built-in driver (Node >= 22.5). No native build step.
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS hazards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      family TEXT NOT NULL,            -- 'surface' | 'water'
      type TEXT NOT NULL,              -- 'breaker' | 'pothole' | 'water'
      lat REAL NOT NULL, lon REAL NOT NULL, heading REAL,
      state TEXT NOT NULL,             -- 'candidate' | 'confirmed' | 'cleared' | 'rejected'
      created_ts INTEGER NOT NULL, confirmed_ts INTEGER, cleared_ts INTEGER, last_hit_ts INTEGER,
      severity REAL, clean_streak INTEGER NOT NULL DEFAULT 0,
      n_events INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS hz_state ON hazards(state);
    CREATE INDEX IF NOT EXISTS hz_geo ON hazards(lat, lon);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, heading REAL, speed REAL,
      peak_g REAL, type TEXT NOT NULL, rain INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL,
      hazard_id INTEGER, source TEXT
    );
    CREATE INDEX IF NOT EXISTS ev_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS ev_hz ON events(hazard_id);
    CREATE TABLE IF NOT EXISTS passes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hazard_id INTEGER NOT NULL, device TEXT NOT NULL, ts INTEGER NOT NULL, hit INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ps_hz ON passes(hazard_id);
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,              -- 'complaint' (one hazard) | 'city' (weekly report)
      hazard_id INTEGER, ref TEXT NOT NULL, recipient TEXT, channel TEXT NOT NULL,
      status TEXT NOT NULL,            -- 'sent' | 'failed' | 'prepared'
      provider_id TEXT, ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rp_hz ON reports(hazard_id);
  `);
  // Per-spot car tag (14.2): the same car counts once at a spot across days, but tags for different
  // spots can't be linked, so a car can't be tracked across places. Added to older databases too.
  const cols = db.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
  if (!cols.includes("car")) db.exec("ALTER TABLE events ADD COLUMN car TEXT");
  // Breaker vs pothole evidence per jolt (14.3): first movement up/down, and whether both axles hit.
  if (!cols.includes("first")) db.exec("ALTER TABLE events ADD COLUMN first TEXT");
  if (!cols.includes("pair")) db.exec("ALTER TABLE events ADD COLUMN pair INTEGER");
  return db;
}

module.exports = { openDb };
