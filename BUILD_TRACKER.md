# Sadak Sense build tracker

Source of truth for what is built and what is not. Every requirement from the spec sheet
(handover Section 14, items 14.1–14.12, plus the requests made on 26 Nov 2026) is split into
checkable items. Update this file and push after every finished item.

Status: `[x]` built, tested and pushed · `[~]` partly built (note says what's missing) · `[ ]` not built ·
`[P]` production only (needs Hyundai or a company; explained, not codeable) · `[U]` needs the owner (account, password, decision)

Last updated: 26 Nov 2026 (session 1).

---

## 14.1 Alert styles (voice optional)
- [x] 1.1 Setting "Alert style" with three options: Voice / Chime + card / Silent (start screen + in-drive quick switch)
- [x] 1.2 Voice: chime + card + spoken line
- [x] 1.3 Chime + card is the default
- [x] 1.4 In Chime + card, voice still speaks for serious events only: flooded underpass, tyre damage, an agent asking permission
- [x] 1.5 Silent: card only + coloured edge glow (amber breaker, red pothole, blue water), nothing audible (no chime, no voice)
- [x] 1.6 Silent: agent questions become a card with large Haan / Na buttons
- [x] 1.7 No phone push notifications while driving: the app registers no push at all (service worker has no push handler); in-drive messages follow 14.4

## 14.2 No "Was it a pothole?" by default
- [x] 2.1 Every jolt recorded and sent automatically, no question (commit c3ba6e7)
- [x] 2.2 Own-car repeat memory: same car felt the same spot on several days → strong signal for that driver's own route (personal warning before fleet confirmation)
- [x] 2.3 Own car still counts as ONE car on the public map across days (today's daily-rotating ID would count it once per day: fix with a per-spot car tag that can't be linked across places)
- [x] 2.4 "Help improve the map" setting, off by default; when on, ask only when stopped or slow

## 14.3 Breaker vs pothole
- [x] 3.1 Axle timing (front then rear, wheelbase ÷ speed): built; now reported per jolt as evidence
- [x] 3.2 Up/down shape: breaker = car goes up first; pothole = car drops first
- [x] 3.3 Fleet both-directions check: felt in both directions → breaker; one direction/lane → pothole
- [x] 3.4 Stable for months (breaker) vs disappears after repair (pothole): use age and clean-pass history in the decision
- [x] 3.5 Explain the decision in the hazard details (console + car screen): shape, axle timing, directions, age
- [P] 3.6 Per-wheel speed (left/right wheel) — needs the car's wheel-speed sensors; documented in detector.js; deck to mention

## 14.4 Drive-aware notifications
- [ ] 4.1 Moment detector on the phone: moving on a clear road / stopped at a red light / traffic jam / moving with hazards / parked
- [x] 4.2 Traffic signal locations from OpenStreetMap (Overpass API, cached on the server)
- [x] 4.3 Fleet-learned stop lines: cars report where they stop at a signal; server learns the stop line
- [ ] 4.4 Fleet pattern: cars stop then all start together (signal) vs irregular creep (jam)
- [ ] 4.5 Own car: speed 0, near the front of the queue (close to the stop line)
- [P] 4.5b Brake pedal / auto-hold signal — needs car data
- [ ] 4.6 Red time left: learned red duration per signal by time of day, plus current phase from other cars stopped at the junction
- [ ] 4.7 Cold start: OpenStreetMap signal + cautious default cycle
- [ ] 4.8 Delivery tiers: >40 s → message with reply option or a short call; 15–40 s → one-line summaries; <15 s → nothing; jam → hold and batch
- [ ] 4.9 Clear road delivery (steady speed, no hazard ahead): one-line summaries only
- [ ] 4.10 Hold and batch in traffic; deliver the batch at the next good moment
- [ ] 4.11 Only urgent and VIP messages break through holds, and still only at safe moments
- [ ] 4.12 Demo: simulate red-light countdown and traffic-jam states (Simulate + Full demo)

## 14.5 Commute awareness, onboarding, no cold start
- [ ] 5.1 Optional onboarding (~30 s): work days, office time, home/office (or "learn it"), apps to connect, VIP contacts (boss, family), evening preference (yes / urgent only / no), usual passengers, language, alert style
- [ ] 5.2 Default if skipped: weekday 7–11 am → work notifications on, at calm moments
- [ ] 5.3 Default: evenings and weekends → personal only; work held unless VIP or urgent
- [ ] 5.4 After about a week: learn the real commute (home, office, times) from trip patterns
- [ ] 5.5 Gentle "set your office time?" reminder every few days
- [ ] 5.6 Voice override: "Aaj shaam bhi office messages batana" (and the opposite)

## 14.6 Context co-pilot (Gmail, Outlook, Teams)
- [~] 6.0 Reads next meetings, unread Gmail (Primary) and Teams; replies with read-back + yes; running-late email (built)
- [ ] 6.1 Builds knowledge across apps: people, threads, chats, meetings, places, and links between them (knowledge graph)
- [ ] 6.2 Understands what a message refers to (which thread / meeting / earlier message)
- [ ] 6.3 Notifies with context ("Riya again about the review you're driving to")
- [ ] 6.4 Understands vague spoken replies ("haan bol do pahunch raha hoon") and turns them into a proper message
- [ ] 6.5 Adds context to replies
- [ ] 6.6 Automatic ETA line on replies: "Sent from my Hyundai <model>: reaching <place> <time>, <road event on the way>"
- [ ] 6.7 Live ETA, route and road events used in replies and notifications
- [ ] 6.8 Drive-aware delivery (uses 14.4)
- [ ] 6.9 Meeting rescue: late for a call → tell the organiser
- [ ] 6.10 Meeting rescue: join by audio when parked (open the Teams / Meet join link)
- [ ] 6.11 Demo: simulated, labelled "designed, in development" when no accounts are connected
- [ ] 6.12 "What I know" view: show the knowledge graph to the owner

## 14.7 Languages and free speech
- [x] 7.1 Tamil, Telugu, Malayalam, Kannada, Bengali added to English, Hindi, Hinglish (Sarvam voice; commit 24ee136)
- [x] 7.2 Hear: Sarvam speech-to-text (auto-detect); browser recognition as fallback with the right language code
- [ ] 7.3 Understand: Sarvam LLM on the server (key never in the page) with tools for live facts: hazards ahead, ETA, car state, messages
- [ ] 7.4 It must never invent a hazard (answers about hazards come only from the hazard tool)
- [x] 7.5 Reply in the same language (Sarvam voice)
- [ ] 7.6 Offline fallback: rule-based brain when the LLM or network fails
- [ ] 7.7 Written-sentence tests in all 7 languages
- [U] 7.8 One real spoken test per language by a native speaker

## 14.8 Moat features
- [~] 8.1 Near-miss line in Simulate and Full demo (built, simulated)
- [ ] 8.2 Real near-miss detection: hard-braking events from the phone → clusters by place and hour in the engine
- [ ] 8.3 Near-miss zones on the console and warnings in the app ("Sudden braking is common here at this hour")
- [ ] 8.4 Fleet-learned signal red time (shared with 14.4)
- [ ] 8.5 Hazard-aware Smart Cruise: roadmap slide only (deck)

## 14.9 Personalisation
- [ ] 9.1 Commute memory: brief only when something changed ("New pothole since yesterday near AIIMS gate")
- [ ] 9.2 Elders or kids on board → smoother route and gentler advice
- [ ] 9.3 Learned comfort profile (how this driver takes breakers; adjusts advice)
- [ ] 9.4 Quiet hours / focus mode before important meetings
- [ ] 9.5 Monsoon personal warning before leaving
- [ ] 9.6 "Reached safely" alert for a parent of a young driver
- [ ] 9.7 Road-wear cost forecast ("this route costs about ₹800 a year in extra tyre wear")

## 14.10 Email home
- [~] 10.1 EmailJS sending built; [U] needs EmailJS keys, then a reroute test to the home email

## 14.11 Deck and PDFs
- [ ] 11.1 Apply audit fixes and India findings
- [ ] 11.2 New features and the real-system status; app slide "Sadak Sense inside myHyundai" (4 mock-ups); Smart Cruise roadmap
- [ ] 11.3 Keep the light design and the AI declaration; regenerate the 3 PDFs into hyundai_submission
- [U] 11.4 Decide about the 8-slide SadakSense_Ideathon.pptx

## 14.12 Optional
- [U] 12.1 Update the frozen judges' link only if the owner decides
- [U] 12.2 Delete the old Claude artifact (owner must confirm)

## Added 26 Nov 2026
- [x] A.1 Shared fleet with real-phone tracking, export and replay
- [x] A.2 City complaint and weekly report emails (Resend, test inbox)
- [x] A.3 Owner sign-in, Gmail/Calendar/Teams, TomTom maps, leave-by
- [x] A.4 Installable app (manifest, icons, service worker)
- [x] A.5 Car-screen mode /car/
- [ ] A.6 Pairing: dashboard phone senses, car screen shows it live
- [ ] A.7 Android APK (Trusted Web Activity) [U] owner types the keystore password
- [U] A.8 Accounts in Render (see SADAK_SENSE_SETUP.md), real drive with 3 phones

---

## Build log
- 26 Nov 2026: tracker created.
- 26 Nov 2026: 14.1 alert styles built (Voice / Chime + card default / Silent with glow and big Haan-Na; serious events speak in Chime mode; Full demo forces Voice and restores). Next: 14.2.
- 26 Nov 2026: 14.2 built: own-car memory on the phone (spot felt on 2+ days warns this driver before fleet confirmation; 3 smooth passes forget it), per-spot car tag so one car counts once per spot across days, optional "Help improve the map" asking only when stopped/slow (Gaddha / Speed breaker / Kuch nahi → /api/label). Next: 14.3.
- 26 Nov 2026: 14.3 built: detector reports first movement up/down + axle pair; fleet decides type from votes, both-directions (+3 breaker) and 60-day permanence; up-first jolts merge across directions; reasons shown in console and by tapping the warning. Next: 14.4.
- 26 Nov 2026: 14.4 server part built (server/signals.js): OSM signals via Overpass (cached), fleet-learned stop lines and signals, red length per approach/hour from front-of-queue waits (p90, 5+ samples, else cautious 45 s), current phase from Hyundais stopped now, start-together ratio. In progress: phone moment detector + delivery tiers.
