# Outreach Hub

A small GoHighLevel-style outreach tool on **your own Twilio account**:

- **Contacts**: CSV import, tags, statuses, opt-out and do-not-call flags
- **Inbox**: two-way SMS conversations
- **SMS campaigns**: merge fields (`{{first_name}}`), background sending, pause/cancel, reply counts, automatic STOP handling
- **Power dialer**: your browser is the phone. It dials one lead at a time, detects answering machines, and either rings you (a person answered) or plays your recorded **voicemail drop** and moves on. Auto-dial next lead, call script, dispositions, manual "Drop voicemail" button
- **Voicemails**: record in the browser or upload a file
- Calling-hours window, max attempts, DNC list

## How it fits together

```
GitHub Pages (docs/)  ──────►  Cloudflare Worker (worker/)  ──────►  Twilio
 the UI, static files          holds your Twilio secrets,             SMS + Voice
 no secrets in it              D1 database, webhooks, SMS queue
```

GitHub Pages can only serve static files, and Twilio credentials must never sit in browser code, so a tiny backend is required. A Cloudflare Worker is free for this scale and is one file with no dependencies (`worker/src/index.js`).

## Set it up (about 20 minutes)

### 1. Twilio
1. In the Twilio Console, copy your **Account SID** and **Auth Token**.
2. Buy a phone number with SMS and Voice.
3. US texting: register for **A2P 10DLC** (Messaging, Regulatory Compliance). Carriers block unregistered marketing texts.
4. A trial account only reaches verified numbers. Upgrade to message real contacts.

### 2. Cloudflare Worker

**No command line (dashboard):**
1. Cloudflare dashboard, **Workers & Pages**, **Create**, **Hello World**, name it `outreach-hub`, Deploy, then **Edit code**. Replace everything with the contents of `worker/src/index.js`. Deploy.
2. **Storage & databases**, **D1**, create a database named `outreach-hub`.
3. Worker, **Settings**, **Bindings**, **Add**, **D1 database**: variable name `DB`, pick that database.
4. Worker, **Settings**, **Variables and Secrets**: add secrets `APP_PASSWORD` (choose a long one), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and a plain variable `ALLOWED_ORIGIN` = `https://YOURNAME.github.io`.
5. Worker, **Settings**, **Triggers**, **Cron Triggers**: add `* * * * *` (this is what sends campaign texts in the background).

**Or with Wrangler:**
```bash
cd worker
npx wrangler d1 create outreach-hub          # paste the database_id into wrangler.toml
# edit ALLOWED_ORIGIN in wrangler.toml
npx wrangler secret put APP_PASSWORD
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler deploy
```
Tables are created automatically on first use. Note your Worker URL (`https://outreach-hub.<you>.workers.dev`).

### 3. GitHub Pages
Push this repo to GitHub, then **Settings, Pages, Deploy from a branch, `main`, folder `/docs`**. Your UI is at `https://YOURNAME.github.io/REPO/`.

### 4. Connect
Open the page, enter the Worker URL and your `APP_PASSWORD`. Go to **Settings, Load my Twilio numbers, Connect this number**. That one click:
- points the number's SMS and voice webhooks at your Worker,
- creates the TwiML App and API key that browser calling needs.

Then import contacts, record a voicemail, and open the Dialer.

## Using the dialer
1. **Voicemails**: record or upload your message (20 to 30 seconds works best).
2. **Dialer**: tick the consent box, **Start session** (allow the microphone), pick a list, **Load queue**.
3. **Dial**. When a person answers, your browser rings and connects automatically. When a machine answers, the voicemail plays after the beep and the call ends. Turn on **Auto-dial** to roll straight to the next lead.
4. Tag the outcome (Interested, Call back, Do not call...). Do-not-call and wrong numbers are never dialed again.

If their greeting wasn't detected as a machine and you hear it, press **Drop voicemail** to play your recording right away.

## Things worth knowing
- **It is not "ringless".** Twilio has no ringless-voicemail feature. The drop is a real call: the phone rings, voicemail picks up, and your recording plays after the beep.
- **Cost:** voice minutes plus Twilio's answering-machine detection fee per call, and SMS segments. Check Twilio's current pricing.
- **Compliance is on you.** Only text people who opted in. Prerecorded voicemail drops count as calls under US TCPA rules, so you need permission for those numbers and should scrub the Do Not Call registry. STOP replies are honored automatically, and sending and calling are limited to the hours in Settings (default 11 AM to 8 PM Eastern, which sits inside 8 AM to 9 PM in every US time zone).
- **One agent, one call at a time.** Cloudflare's free plan allows about 20 campaign texts per minute (raise it in Settings on a paid plan). Voicemails are capped at roughly 80 seconds.
- Passwords and the Worker URL live in your browser's local storage. Sign out in Settings on shared computers.

## Trying it without any accounts
```bash
python3 -m http.server 8791
```
- `http://127.0.0.1:8791/test/app.html?seed=1`: the real UI running against the real Worker code with an in-memory database, a fake Twilio and a fake phone.
- `http://127.0.0.1:8791/test/worker-test.html`: automated checks for the Worker (webhook signatures, STOP handling, campaigns, the voicemail-drop flow, calling hours...).

## Layout
```
docs/      the GitHub Pages site (plain HTML/CSS/JS, no build step)
worker/    Cloudflare Worker (single file) + wrangler.toml
test/      browser-based test harness (not deployed)
```

MIT licensed.
