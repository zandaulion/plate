# Plate

Photograph a meal, correct the portion, log it.

A calorie and macro log whose primary input is a photo. The model reads the
plate; the person who ate it corrects the weight. That division of labour is
not a convenience — it is the finding the whole design rests on.

## Why the portion control is the main interaction

Measured on **145 plates from Nutrition5k**, where every ingredient was weighed
on a scale before the photo was taken (`gemini-3.7-flash`, 30 Aug 2026):

| | Median calorie error | Plates within 25% |
|---|---|---|
| Model estimates everything | 30.0% | 44% |
| Weight corrected by the user | 16.0% | 66% |

Two other results shaped the code:

* **A food database does not help.** Taking per-gram nutrition from a lookup
  table instead of the model changed nothing (34.8% → 34.0% MAPE). The model
  already knows what rice contains; it does not know how much is on the plate.
  So `core/analysis/estimate.js` keeps the model's per-gram rates and spends
  the user's effort on grams instead.
* **Fat is not readable from a photograph.** Worst nutrient in every
  arrangement, and the only one that got *worse* when the weight was corrected.
  Absorbed oil and dressing are invisible from above. It is carried at lower
  confidence and given a wider band throughout.

The error bands in `ERROR_BANDS` are those measured medians, which is why the
displayed range genuinely narrows once the portion is confirmed. It is a
measurement, not a reward animation.

The harness that produced these numbers is separate from this repo.

## Layout

```
core/     portable. No Node, no browser APIs — the Android client reuses it
  nutrition.js          Mifflin-St Jeor, activity factors, Atwater arithmetic
  day.js                local-day keys, daily summary, macro split
  analysis/prompt.js    the vision prompt and its response schema
  analysis/estimate.js  per-gram items, portion rescaling, confidence bands
server/   Express API over SQLite
web/      the PWA; imports the same core/ modules the server runs
deploy/   Containerfile and the systemd quadlet
```

`core/` is served to the browser at `/core`, so the PWA and the server run one
implementation rather than two that drift. Test files are excluded from that
mount.

## Design decisions worth knowing

* **Maintenance energy is a band, never a target.** `maintenanceEnergy()`
  returns low/point/high, and the day view reports intake inside that band as
  indistinguishable from maintenance. The app computes what you burn; it does
  not prescribe what to eat. There is deliberately no "remaining" figure and no
  suggested deficit.
* **The day is the client's local calendar date**, sent with the entry.
  Deriving it from a UTC timestamp server-side would misfile a late dinner for
  anyone outside UTC.
* **Photos are downscaled in the browser** to a 1280px edge before upload. The
  model sees no more detail beyond that, and it saves most of the round trip.
* **Height, weight, age and sex exist only to compute maintenance energy.**
  They are stored on this server and sent nowhere else. Photos go to the model;
  the profile never does.
* **Out-of-range profile values are rejected, not clamped** — silently altering
  a stated weight produces a number the user cannot account for.

## Running it

```bash
npm install
npm test                 # core unit tests and API tests against real SQLite
npm start                # binds 127.0.0.1 by default
```

Configuration, all via environment:

| | |
|---|---|
| `GEMINI_API_KEY` | required for photo analysis; without it the app runs and `/api/analyse` returns 503 |
| `GEMINI_MODEL` | defaults to `gemini-3.7-flash` |
| `DATA_DIR` | SQLite database and photo files |
| `PORT`, `BIND_HOST` | `BIND_HOST` stays on loopback unless set; the container sets it explicitly |

## Access

Invite-only. Codes are minted through `/api/admin/*`, which is reachable only
on the private listener that injects `X-Admin`; the public listener answers 404
for those paths before the request reaches the app. Invite codes and device
tokens are stored as SHA-256 hashes, so the database holds no reusable secret.

## Deploying

Build the image from `deploy/Containerfile`, install
`deploy/quadlet/plate.container`, and put the API and shell behind a reverse
proxy that strips `X-Admin` and blocks `/api/admin/*`. The service reads its
secrets from an environment file outside this repo.

Bump `CACHE_NAME` in `web/sw.js` on every shell change, or installed clients
keep serving the old build.

## Not built yet

* Barcode scanning against Open Food Facts — exact for packaged food, costs
  nothing per scan, and needs no model call.
* Editing a saved entry. Entries can currently be deleted and re-added.
* Any history beyond `/api/days`; there is no chart or trend view.
* Offline logging. The shell is cached, but an entry needs the network.
