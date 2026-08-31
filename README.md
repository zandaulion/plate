# Plate

Photograph a meal, correct the portion, log it.

A calorie and macro log whose primary input is a photo. The model reads the
plate; the person who ate it corrects the weight. That division of labour is
not a convenience — it is the finding the whole design rests on.

## Why the portion control is the main interaction — and its limit

Measured on **145 plates from Nutrition5k**, where every ingredient was weighed
on a scale before the photo was taken (`gemini-3.7-flash`, 30 Aug 2026):

| Weight source | Median calorie error | Plates within 25% |
|---|---|---|
| Model's own guess | 30.0% | 44% |
| User guessed, ±10% | 17.8% | 63% |
| User guessed, ±20% | 22.6% | 54% |
| User guessed, ±30% | 28.4% | 45% |
| User guessed, ±40% | 34.0% | 38% |
| Weighed on a scale | 16.0% | 66% |

The first run only compared the top and bottom rows, which made the portion
control look better than it is. The middle rows are the honest picture:
**correcting by eye recovers about half of what a scale does, and stops helping
once the guess is worse than about ±30%.** Past ±40% it is actively worse than
leaving the model's estimate alone — the model's own weight guess has a median
error of 20.5%, and a user has to beat that to add anything.

This is why the app asks *how* the weight was arrived at rather than merely
whether it was changed, why the three `ERROR_BANDS` levels exist, and why the
weight control's wording says "only worth changing if you have a better idea
than the photo does" instead of urging every user to adjust every meal.

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
| `USDA_API_KEY` | optional; removes the demo key's hourly cap on generic food search |
| `DATA_DIR` | SQLite database and photo files |
| `PORT`, `BIND_HOST` | `BIND_HOST` stays on loopback unless set; the container sets it explicitly |

## Two sheets, not one

The topbar has a person and a gear, because they lead to different kinds of
thing. **You** holds body details, the weight chart and what the app makes of
them. **Settings** holds devices, export and recovery.

They were one sheet, and putting height and age next to device revocation made
both harder to find — the daily question ("what does it think I burn?") and the
rare one ("revoke my old phone") were sharing a scroll.

## Accounts, devices and getting back in

A person is an **account**; a phone or tablet is a **device**. History and the
profile belong to the account, so every device signed into it sees one log.
The first version made the device the identity, which meant a second install
was a second person and a cleared cookie was an unreachable history.

An account holds no name, email, phone or password. Identity is a random id
and nothing else.

Invites are minted from the shared admin console, which fronts several apps
through one page on a private listener. An invite carries an id, a seven-day
expiry and a link; its plaintext code is stored **only while it can still
register something** and is cleared in the same statement that spends it, so a
used invite leaves nothing behind. Verification always runs against the hash.

Opening an invite link fills the code into the gate and strips it from the
address bar immediately — a live credential should not sit in browser history
or in a screenshot of the tab — but does not submit it. The person sees what is
about to happen and presses the button.

Three ways in, because a device token is the only credential and it can be lost:

* **Invite code** — creates a new account and its first device.
* **Link code** — minted on a device already signed in, valid ten minutes,
  single use. Holding a working device is the authority to add another.
* **Recovery code** — issued once at signup, stored hashed, and the only route
  back when no device survives. It is deliberately *not* consumed on use:
  someone recovering a lost phone may have to do it again, and burning their
  only route on first use would strand them.

Revoking a device from the console is reversible: the row stays so it can be
restored, and it stops authenticating in the meantime. Removing a device ends
its access and nothing else — entries belong to the
account, so a lost phone costs a session, not a log. Deleting the *account* is
the destructive operation.

Invite, link and recovery codes are all stored as SHA-256 hashes, as are device
tokens, so the database holds no reusable secret. Redemption is globally
throttled: with no client address passed through the proxy there is no
per-client key to throttle on, and none should be introduced for this.

Admin routes are reachable only on the private listener that injects
`X-Admin`; the public listener answers 404 for those paths before the request
reaches the app.

## Deploying

Build the image from `deploy/Containerfile`, install
`deploy/quadlet/plate.container`, and put the API and shell behind a reverse
proxy that strips `X-Admin` and blocks `/api/admin/*`. The service reads its
secrets from an environment file outside this repo.

Bump `CACHE_NAME` in `web/sw.js` on every shell change, or installed clients
keep serving the old build.

## Recent foods

Eating repeats, so the finder offers previously logged foods before anything is
typed, at the weight last used. Ranking blends how often a food is eaten with
how recently — halving every fortnight — so a weekday staple outranks last
night's restaurant dish even though the dish is newer. That is deliberately
instead of a favourites feature: the foods someone would star are the ones they
already log most.

The list is derived from `entries` rather than a separate table, so it cannot
fall out of step with what was actually eaten.

## Adding food without a photo

A photo is not the only way in, and should not be: logging a banana should not
require photographing it.

* **Barcode** — Open Food Facts, looked up by scanning with the browser's
  `BarcodeDetector` or by typing the number. Exact, free, and cached, so the
  yoghurt you scan every morning costs one network call ever. The product photo
  is fetched too, so a scanned entry looks like a photographed one in the log
  rather than being the row with an empty square.

  **The server fetches that picture, never the browser.** Loading it from
  Open Food Facts directly would hand them the reader's address and a list of
  what they eat, which proxying the lookups exists to prevent. The image is
  cached once per barcode, then *copied* into each entry that uses it — shared
  files would be unlinked out from under other entries on the first delete, and
  copies keep deletion and export behaving exactly as they do for a photograph.
* **Search** — a **bundled** USDA table for generic whole foods, Open Food
  Facts for packaged ones, merged and re-ranked. Open Food Facts alone is a
  poor generic index: searching *banana* there returns banana yoghurt and
  banana chips before fruit.

`assets/foods.sqlite` holds 7,832 foods in 1.7 MB, built by
`scripts/build-food-table.mjs` from USDA FoodData Central. No key, no network,
no rate limit — the demo key it replaced was capped at about thirty requests an
hour, which one evening of searching exhausts. It also means generic search
keeps working with no connection at all, which is what the Android app will
need: a key cannot travel inside a build where anyone can extract it.

Ranking is scored per word, not on the phrase, because USDA writes names back
to front — *olive oil* has to reach "Oil, olive, salad or cooking". A whole
word beats a word that merely starts the same way, so "Eggnog" stays below
"Egg, whole" for *egg*; the first word of a name is treated as its head noun,
so "Flour, rice, white" loses to "Rice, white" for *white rice*; and how much
of the name the query accounts for breaks the remaining ties.

It is good, not perfect. *banana*, *egg*, *cheddar*, *almonds* and *greek
yogurt* land on the right entry; *chicken breast* and *salmon* still surface a
breaded product first, because USDA names plain cuts at length and processed
ones tersely.

**Database items carry no photo-error band.** The measured ranges apply to
what a model read off a photograph; a scanned barcode's nutrition is exact, and
its only uncertainty is the weight entered. A meal mixing both shows a band
around the photographed part only.

**Records are checked for physical possibility before use.** Crowd-sourced
databases contain entries with kilojoules in the kcal field or per-package
figures in a per-100 g field; one *olive oil* record claimed 6,209 kcal per
100 g. Nothing above ~900 kcal/100 g is edible, so such records are dropped
rather than logged.

## The back gesture

Overlays are history entries, so the Android back gesture closes the top one
instead of leaving the app. Dismiss buttons do not close anything directly;
they unwind history and let the resulting `popstate` do the closing, so both
gestures follow one path and the history depth cannot drift from the visible
stack.

Day navigation is deliberately excluded — walking back through yesterday and
the day before would make the gesture unpredictable.

Two hazards this has to handle, both found by testing rather than reasoning:
a double tap on a close button would otherwise unwind twice and drop the user
out of the app, and the barcode overlay must register itself *before* the
camera warms up, or a back press during that window closes the sheet
underneath and leaves the camera running.

## One editor, three ways in

The same sheet handles a photo estimate, a search-built meal, and editing
something already saved. The weight slider appears only when part of the meal
came from a photo — for database items the grams were entered deliberately, so
a proportional rescale would fight the user.

## Asking for the profile

A banner appears on the day view only while expenditure genuinely cannot be
computed, and it names the fields that are missing rather than saying "complete
your profile". Sex is never demanded: leaving it out widens the band rather
than blocking the calculation.

It disappears for good once the estimate is measured from logged intake and
weight, because at that point the profile stops feeding the calculation at all.
A banner still asking for details the app no longer uses would be a nag with no
purpose.

**Weight is not in the profile form.** It was, and the result was two numbers
for the same thing on one screen disagreeing with each other — a stale 82.7 in
the field while the maths quietly used the 83 from that morning's weigh-in.
The profile now holds only things that rarely change: height, age, sex and a
typical week. Weight is logged, and the estimate says which reading it used.

Updating the profile is a **partial** update: a field absent from the body is
left alone and only an explicit null clears it. Without that, saving a
corrected height would have silently wiped the stored weight of anyone who had
not yet logged a reading.

**The formula uses the most recent weight reading, not the one typed at
sign-up.** `profiles.weight_kg` was never revised, so someone who had logged
themselves four kilos lighter still had their expenditure computed from the old
figure. A reading on the scale beats a number remembered months ago. The stated
value is left untouched — it is the user's, not ours to overwrite.

## What you actually burn

Mifflin-St Jeor estimates expenditure from height, weight, age and sex, then
multiplies by an activity factor picked from a list. It is a population average
with an arbitrary coefficient attached, and it cannot notice that a particular
person runs cold, fidgets, or has adapted to months of dieting. The market
survey names this as the sector's weak point, and it was what this app did.

The energy balance identity does better once there is data:

```
expenditure = mean intake - (weight slope in kg/day x 7700 kcal/kg)
```

`core/expenditure.js` fits a least-squares line through the weight readings,
takes the mean of logged intake, and reports the result **with a band** built
from three independent errors combined in quadrature: the mean of a noisy
intake estimate, the uncertainty in the weight slope, and the energy density of
the tissue being gained or lost (7,700 kcal/kg is an approximation — fat is
nearer 9,400, lean tissue far less because it is mostly water).

On a simulated user with a true expenditure of 2,500 kcal and a deliberately
wobbly scale, it returns **2,487 (2,260–2,713)**, while Mifflin-St Jeor says
2,759. Both numbers are shown, because a large disagreement between them is
itself information — usually that intake is being under-logged.

**It refuses rather than guessing.** A measurement needs 14 logged days, 75%
coverage of the 28-day window, and 6 weigh-ins spanning a fortnight. Coverage
is the strict one and deliberately so: weight change reflects *every* day in
the window, but mean intake can only be taken over the days that were logged,
so using it assumes the missing days resembled the logged ones — and missed
days are disproportionately the unusual meals. Below the threshold it falls
back to the formula, labelled as such, and says exactly what is still needed.

A day under 400 kcal is treated as partly logged and dropped, not as a day of
near-fasting. Averaging those in would drag mean intake down and inflate
expenditure by hundreds of kcal.

**This is still a measurement, not a target.** It says what someone burns; it
does not say what they should eat. That is the only reason the technique
belongs in an app that refuses to prescribe.

## Weight

Weighing in is on the day view, not in settings — it is a daily action and the
input the expenditure estimate depends on, so burying it beside account
configuration made the one thing the algorithm needs the hardest thing to do.

The row asks while the day has no reading and reports the value and trend once
it does, so it stops being a prompt rather than becoming a nag. Today's prompt
can be dismissed; a past day offers quietly and cannot be dismissed, because a
forgotten Tuesday should still be repairable on Wednesday — the estimate wants
coverage, and a missed morning is otherwise unfixable.

Backfilling pre-fills from the nearest reading **before** that day rather than
the most recent overall: filling in a missed Tuesday should start from Monday,
not from Friday, since a later reading is evidence about a day that had not
happened yet.

Tapping it opens a stepper **pre-filled from the most recent reading**, with
±100 g buttons. Weight moves slowly, so yesterday's number is nearly always
within a nudge of today's; typing four digits every morning throws that away.
Nothing is autofocused, so the common case raises no keyboard. The field stays
typable for when it has genuinely moved.

Stored as a series, one reading per calendar day, rather than the single
scalar `profiles.weight_kg` — a trend is what the expenditure estimate
consumes and a scalar cannot express one. Weighing twice in a morning replaces
the day rather than double-counting it.

The chart draws raw readings as faint dots and the **least-squares fit** as the
line. The dots are there to show that the scale really does jump around, which
is the argument against reacting to any single morning. The line is the fit
rather than a moving average because the fit is what the expenditure figure was
computed from; drawing a different smoother would put a line on screen that
disagrees with the number beside it.

## Correcting what the model saw

A photograph can be read confidently and wrongly. A vegetarian shawarma and a
chicken one look alike, and no amount of portion adjustment fixes the wrong
food — the weight slider assumes the identification was right.

So a photo estimate carries **"Not what you're eating?"**. Say what it actually
is and the same photograph is read again with that correction, using the image
already in memory: one more model call, no second picture. The correction is
kept on the entry's note, so the log records why its numbers changed.

The wording matters. The correction is given to the model as fact rather than
as something to weigh up — a model asked to *consider* an alternative usually
keeps its own answer — and it is told to work the dish out from the start
rather than adjust, because swapping chicken for falafel changes the whole
nutrition rather than one line of it.

This is the only recourse for food that no database holds. The bundled table
has no shawarma, kebab, gyro, seitan or halloumi: USDA is American, Open Food
Facts is packaged goods, and a restaurant wrap in Bucharest is in neither.

## Typing in a printed panel

When a menu or a label states the numbers, they can be typed in directly,
either for the stated portion or per 100 g. Such an item is treated as exact:
no photo-error band is applied to it.

Two checks run as the figures are entered, because printed panels are wrong
more often than people expect. Anything physically impossible is refused
outright — over ~950 kcal per 100 g, or macros that cannot fit in 100 g. And
when the stated calories disagree with the macros by more than 10%, it says so:
the restaurant menu that prompted this feature listed 940 kcal against macros
adding to 807, a 14% contradiction. The app cannot tell which figure is wrong,
so it uses the stated calories and points out that one of them is off.

The threshold has slack for a reason: fibre counts as carbohydrate on EU labels
but yields about 2 kcal/g rather than 4, and panels are rounded, so small gaps
are normal.

## Usage

`GET /api/usage?days=30` reports how the account has been using the app: which
of the three entry paths gets reached for, whether photo portions actually get
corrected, whether weighing has become a habit, when in the day things get
logged, and how much of the logging is repeat foods.

**Nothing is collected for it.** Every figure is derived from rows the app must
keep in order to work — an entry already records when it was written, which day
it was for, how its portion was arrived at, and where each food came from.

It is scoped to the caller by construction: it reads the requesting account and
nothing else, so it cannot report on anyone else's diary regardless of who
asks. That is deliberate. Reading a friend's food log to find out whether a
button works is not a trade worth making, and the invitation these friends
receive says the app does not track anything.

## Trends

Tapping the totals card opens two charts over a shared date axis, at 14, 30 or
90 days.

**Weight** — readings as dots, the least-squares fit as the line. The same fit
the expenditure figure is computed from, so the picture and the number cannot
disagree.

The readings are drawn from the very first one. Only a genuinely empty range
shows nothing: withholding the chart until a trend can be fitted hides
someone's own data from them, and the caption below already says how many more
weigh-ins are wanted and what will happen when they arrive. Without a line the
dots are drawn as the subject rather than as faint scatter, because at that
point they are the whole chart.

**What you ate** — a bar per day, stacked by where its energy came from, with a
dashed line at what you burn. Stacked by *energy* rather than grams on purpose:
the bar's height is then the day's calories and its composition is the macro
split, so one chart answers both questions instead of two that have to be read
together. The burn line is what makes it mean anything — bars above it are
surplus days, bars below are deficit ones, and the weight panel above shows the
consequence.

The series is **dense**: every day in the range is drawn, with a gap where
nothing was logged. A chart built only from days that have data spaces them
evenly and quietly lies about time, turning a week's silence into one step.

## Export

Three shapes, all free, all complete, none gated:

* **`/api/export.zip`** — `plate.json`, `plate.csv` and every photograph.
* **`/api/export.csv`** — one row per food, entry columns repeated, so it
  pivots in a spreadsheet without anyone parsing nested JSON.
* **`/api/export.json`** — loss-free. Items carry their per-gram rates, so
  grams x rate reproduces the stored totals exactly and the log can be read
  back without inference.

Photos are in the archive because an export of a food log that omits the
pictures is a subset of someone's data, not their data. That needs a container,
and `server/zip.js` is a store-only ZIP writer rather than a dependency —
JPEGs do not compress, so the stored form costs nothing, and it is verified in
the tests with the real `unzip` rather than by reading our own bytes back.

Food names reaching a CSV cell are neutralised if they begin with `=`, `+`, `-`
or `@`: spreadsheets execute those, and the names come from a model and a
public database, neither of which is trusted input.

## Not built yet

* Any history beyond `/api/days`; there is no chart or trend view.
* Weight history, and the adaptive expenditure estimate it would enable.
* Health Connect, which is table stakes for an Android release.
* Offline logging. The shell is cached, but an entry needs the network.
* Replacing the photo on an existing entry.
* Recent and favourite foods, which would cut most repeat searches.
