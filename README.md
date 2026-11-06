# Outreach Hub

A small GoHighLevel-style outreach tool on **your own SignalWire account**:

- **Contacts**: CSV import, tags, statuses, opt-out and do-not-call flags
- **Inbox**: two-way SMS conversations
- **SMS campaigns**: merge fields (`{{first_name}}`), **drip sending (1 text every X seconds, default 60)** or fast batches, background sending, pause/resume/cancel, reply counts, automatic STOP handling
- **Follow-up texts**: add up to 5 follow-ups to a campaign, each sent after a delay you choose (minutes, hours or days) counted from the previous text. Anyone who replies or texts STOP drops out automatically
- **Approval tracker**: the dashboard and a banner show whether your SignalWire Brand, Campaign and number are approved for texting, checked every time you open the app
- **Power dialer**: dials one lead at a time, detects answering machines, and either connects a person to you or plays your recorded **voicemail drop** and moves on. Auto-dial next lead, call script, dispositions, manual "Drop voicemail" button
- **Voicemails**: record in the browser or upload a file
- Optional contact-hours window (off until you turn it on), max attempts, do-not-call list

## How it fits together

```
GitHub Pages (docs/)  ──────►  Cloudflare Worker (worker/)  ──────►  SignalWire
 the UI, static files          holds your SignalWire secrets,         SMS + Voice
 no secrets in it              D1 database, webhooks, SMS queue
```

GitHub Pages can only serve static files, and SignalWire credentials must never sit in browser code, so a tiny backend is required. A Cloudflare Worker is free at this scale and is one file with no dependencies (`worker/src/index.js`).

### How the dialer reaches you
You talk on **your own cell phone**. When you press **Start session**, SignalWire calls your phone; answer it and stay on the line. That call sits in a conference. The dialer then places each lead's call with answering-machine detection:

- a **person** answers: they are dropped into your conference and you are talking
- a **machine** answers: your voicemail plays after the beep and the call ends, and you never hear it

The web page is the control panel (queue, script, notes, outcomes). Mute and volume are on your phone.

## Set it up (about 20 minutes)

### 1. SignalWire
1. Create a project at signalwire.com. Note your **Space name** (the part before `.signalwire.com` in your dashboard URL) and the **Project ID**.
2. In the project's **API** tab, create a token with the **Voice**, **Messaging** and **Numbers** scopes. Copy it.
3. Buy a phone number with SMS and Voice. Use one that nothing else points to, because connecting it replaces its webhooks.
4. US texting: register your brand and campaign (10DLC) in the SignalWire dashboard. Carriers block unregistered marketing texts.
5. Trial accounts are restricted (typically only verified numbers can be reached). Upgrade before contacting real people.

### 2. Cloudflare Worker

**No command line (dashboard):**
1. Cloudflare dashboard, **Workers & Pages**, **Create**, **Hello World**, name it `outreach-hub`, Deploy, then **Edit code**. Replace everything with the contents of `worker/src/index.js`. Deploy.
2. **Storage & databases**, **D1**, create a database named `outreach-hub`.
3. Worker, **Settings**, **Bindings**, **Add**, **D1 database**: variable name `DB`, pick that database.
4. Worker, **Settings**, **Variables and Secrets**: add secrets `APP_PASSWORD` (choose a long one), `SIGNALWIRE_SPACE`, `SIGNALWIRE_PROJECT_ID`, `SIGNALWIRE_API_TOKEN`, and a plain variable `ALLOWED_ORIGIN` = `https://YOURNAME.github.io`.
5. Worker, **Settings**, **Triggers**, **Cron Triggers**: add `* * * * *` (this sends campaign texts in the background).

**Or with Wrangler:**
```bash
cd worker
npx wrangler d1 create outreach-hub          # paste the database_id into wrangler.toml
# edit ALLOWED_ORIGIN in wrangler.toml
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SIGNALWIRE_SPACE
npx wrangler secret put SIGNALWIRE_PROJECT_ID
npx wrangler secret put SIGNALWIRE_API_TOKEN
npx wrangler deploy
```
Tables are created automatically on first use. Note your Worker URL (`https://outreach-hub.<you>.workers.dev`).

### 3. GitHub Pages
Push this repo to GitHub, then **Settings, Pages, Deploy from a branch, `main`, folder `/docs`**. Your UI is at `https://YOURNAME.github.io/REPO/`.

### 4. Connect
Open the page, enter the Worker URL and your `APP_PASSWORD`. Go to **Settings**, type **your cell phone number**, **Load my SignalWire numbers**, pick the number, **Connect this number**. That points the number's text and call webhooks at your Worker (each URL carries a private key only your Worker and SignalWire know).

Then import contacts, record a voicemail, and open the Dialer.

## Using the dialer
1. **Voicemails**: record or upload your message (20 to 30 seconds works best).
2. **Dialer**: tick the consent box, **Start session**, answer your phone and stay on the line.
3. Pick a list, **Load queue**, **Dial**. Turn on **Auto-dial** to roll straight to the next lead after each call.
4. When a person answers you are connected on your phone. Hang up on the lead from the page (or they hang up), then tag the outcome (Interested, Call back, Do not call...). Do-not-call and wrong numbers are never dialed again.
5. **End session** when you are done, or just hang up your phone.

If a greeting was not detected as a machine and you hear it, press **Drop voicemail** to play your recording right away.

## Things worth knowing
- **It is not "ringless".** The drop is a real call: the phone rings, voicemail picks up, and your recording plays after the beep.
- **Cost:** voice minutes for the lead call, plus the whole time your own phone leg stays open during a session, plus answering-machine detection fees and SMS segments. Check SignalWire's current pricing.
- **Compliance is on you.** Only text people who opted in. Prerecorded voicemail drops count as calls under US TCPA rules, so you need permission for those numbers and should scrub the Do Not Call registry. STOP replies are honored automatically. No time-of-day limit is applied until you turn on **Contact hours** in Settings (US rules generally allow 8 AM to 9 PM in the contact's own time zone).
- **Texting approval:** the app reads your Brand, Campaign and number-assignment status from SignalWire's registry. The API token needs the Messaging and Numbers scopes. If your browser shows an old version after an update, do a hard refresh.
- **Follow-ups:** each follow-up is scheduled from when the previous text actually went out, so "1 day" means a day after that person's text, not a day after you pressed send.
- **Drip sending:** each campaign has a "Drip: send 1 text every X seconds" box (default 60, change the default in Settings). The Worker's once-a-minute cron sends whichever texts are due, so spacing under about 30 seconds is approximate. Untick drip for fast batches (about 20 a minute on Cloudflare's free plan).
- **One person, one call at a time.** Voicemails are capped at roughly 80 seconds.
- Your password and the Worker URL live in your browser's local storage. Sign out in Settings on shared computers.
- Not yet verified against live SignalWire: this was built from SignalWire's documentation and tested against a simulator. Do your first calls on your own phone numbers.

## Trying it without any accounts
```bash
python3 test/serve.py
```
- `http://127.0.0.1:8791/test/app.html?seed=1`: the real UI against the real Worker code with an in-memory database and a fake SignalWire. Use the `__sim` helpers in the browser console to play SignalWire's part of a call.
- `http://127.0.0.1:8791/test/worker-test.html`: automated checks for the Worker (webhook keys, STOP handling, campaigns, the session and voicemail-drop flow, calling hours...).

## Layout
```
docs/      the GitHub Pages site (plain HTML/CSS/JS, no build step)
worker/    Cloudflare Worker (single file) + wrangler.toml
test/      browser-based test harness (not deployed)
```

MIT licensed.
