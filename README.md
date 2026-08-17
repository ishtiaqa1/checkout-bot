# Target Checkout Bot

A personal-use tool that **monitors target.com for fast-selling drops** (e.g. Pokémon
ETBs and special releases) and **assists you through checkout** the instant an item
goes in stock. It uses your own logged-in Target session via a real browser, so it
behaves like you checking out — just much faster.

> **Read this first.** This tool is for **personal use on your own account**. Automated
> ordering may violate Target's Terms of Service, and Target actively uses bot detection.
> Use reasonable poll intervals, buy only what you'd buy by hand, and don't use it for
> scalping. You are responsible for how you use it. Ships with **dry-run on by default**
> so it can't accidentally buy anything until you opt in.

## How it works

1. **Monitor** – polls Target's stock API (fast) or a real browser page (resilient fallback)
   for each product you list.
2. **Notify** – plays a sound + desktop notification the moment something is in stock.
3. **Checkout** – drives a real Chromium browser (already logged into your Target account)
   to add the item to your cart and walk through checkout.

There are three safety levels for checkout, set in `config.json`:

| Setting | Behavior |
| --- | --- |
| `dryRun: true` (default) | Fills the cart and stops at the review screen. **Never buys.** Great for testing. |
| `dryRun: false`, `autoPlaceOrder: false` | Gets you all the way to the final review screen; **you** click *Place order*. |
| `dryRun: false`, `autoPlaceOrder: true` | Bot clicks *Place order* automatically. Use only when you're confident. |

## Quick start — no command line needed

**Double-click `Start Checkout Bot.bat`.** The first run installs everything automatically,
then the dashboard opens in your browser. Keep that little black window open while you use
the app; close it to stop the bot.

(First launch downloads a browser engine, so it may take a couple of minutes once.)

Then, all in your browser:

1. Click **Sign in to Target** and log in once (your session is saved — you stay signed in).
2. **Create a product card**: give it a name, type **keywords** (press Enter after each), and
   pick a **match threshold** (default 90%). Click **Add product card**.
3. Repeat for as many products as you want (e.g. one card for *pokemon, prismatic, evolutions*
   and another for *mega, charizard, ultra, premium, collection*).
4. Set your **ZIP/store** and **checkout safety** under Settings.
5. Press **Start**. The bot finds any Target product whose title matches **at least your
   threshold %** of a card's keywords, then checks it out using your **default Target address
   and saved card**.

Each card shows live status: *Searching → Watching → In stock → Processing → Placing order →
Success* (or Failed / Dry run / Needs you). The **Activity** panel streams a live log, and you
get a sound + desktop alert on stock hits.

### Test a card without buying

Every card in your Watchlist has a **Test** button. It runs the *entire* checkout flow in
forced **dry-run** mode — finds the product, adds it to the cart, and goes to the review
screen — then **stops before paying**. Nothing is ever purchased.

The status board and Activity log show each step live, and when it finishes you get a timing
breakdown (e.g. `navigating +1.2s · adding_to_cart +0.8s · checking_out +2.1s`) plus the total
time it took to reach checkout. Use this to confirm your login, address, card, and keywords are
all set up correctly before a real drop.

### Product cards & the match threshold

A card matches a product when the product's **title contains at least `matchThreshold`** of
the card's keywords. Use **Preview matches** while building a card to see exactly which Target
products would qualify (green = the bot would buy it) and tune your keywords/threshold.

Example: a card with keywords `mega, charizard, ultra, premium, collection` at 90% needs all 5
words present (4/5 = 80%, which is below 90%). Lower the threshold to be more lenient.

### Status meanings

| Status | Meaning |
| --- | --- |
| **Searching** | Resolving your keywords to a real product |
| **Watching** | Polling for stock |
| **In stock** | Detected available — starting checkout |
| **Processing** | Adding to cart / moving through checkout |
| **Placing order** | Submitting the order |
| **Success** | Order placed |
| **Dry run** | Cart filled but not purchased (dry-run mode) |
| **Needs you** | Cart ready — click *Place order* in the browser window |
| **Failed** | Something went wrong (see Activity log + `./screenshots`) |

## CLI (optional)

Everything is also available from the terminal:

```powershell
node src/index.js login                 # sign in
node src/index.js search "pokemon etb"  # find TCINs
node src/index.js check                 # one-off stock check
node src/index.js run                   # headless-of-UI monitoring loop
```

## Product cards in config.json

You normally create cards in the dashboard, but they're stored in `config.json` like this:

```jsonc
"products": [
  {
    "name": "Prismatic Evolutions ETB",
    "keywords": ["pokemon", "prismatic", "evolutions"],
    "matchThreshold": 0.9,   // title must contain >= 90% of the keywords
    "maxQuantity": 1,
    "enabled": true
  }
]
```

You can also pin an exact product by `"tcin": "1004295730"` instead of keywords if you prefer.
Set your `location` (zip / store) so stock checks reflect what you'd actually see.

### Fully automatic checkout

To have the bot buy on its own using your **default shipping address and default saved card**:

1. Run `node src/index.js login` and make sure your default address + payment are set on Target.
2. In `config.json` set `"dryRun": false` and `"autoPlaceOrder": true`.
3. If Target prompts for your card's security code at checkout, provide it via the
   `CHECKOUT_CVV` environment variable (preferred) or `checkout.cvv` in config.

The bot uses whatever Target has saved as your default — it does not enter new address/card details.

## Commands

| Command | What it does |
| --- | --- |
| `node src/index.js ui [port]` | Launch the web dashboard (default port 5173) |
| `node src/index.js login` | Open a browser to sign in to Target (saved for later) |
| `node src/index.js search "<words>"` | Search Target by keyword and print matching TCINs |
| `node src/index.js check` | Check stock for all products once and exit |
| `node src/index.js run`   | Continuously monitor and auto-checkout on stock |

## Tuning & tips

- **Poll interval**: `monitor.pollIntervalMs` (+ random `jitterMs`). Don't set this too
  aggressively low or you'll get rate-limited / flagged. 3–6 seconds is reasonable.
- **API key**: `monitor.apiKey` is the public key Target's website uses for its stock API.
  If `check` starts returning HTTP errors, the key rotated — open target.com, press F12 →
  **Network**, filter for `redsky`, and copy the `key=` value from a request into config.
- **Selectors break**: Target changes its site often. If checkout fails, look in
  `./screenshots/` for where it stopped, then update the selectors in `src/checkout.js`.
- **Switch to browser mode**: set `monitor.mode` to `"browser"` if the API stops working
  — slower, but reads the real product page.

## Project layout

```
src/
  index.js     CLI entry (ui / login / search / check / run)
  server.js    Express server + REST API + live SSE event stream
  engine.js    Controllable monitor/checkout loop (emits live status events)
  config.js    Loads, validates and saves config.json
  search.js    Keyword product search (resolves keywords -> TCIN)
  monitor.js   Stock checking (RedSky API + browser fallback)
  checkout.js  Playwright login + add-to-cart + checkout (emits phases)
  notifier.js  Desktop + sound alerts
  logger.js    Pretty console logging
public/
  index.html   Dashboard markup
  styles.css   Dashboard styling
  app.js       Dashboard logic (fetch + EventSource live updates)
Start Checkout Bot.bat   Double-click launcher (installs deps + opens dashboard)
```

## Troubleshooting

- ***"Something went wrong on our end"* when signing in** → that's Target's bot detection. The
  app now starts your **real Google Chrome as a normal program and attaches to it** (instead of
  a Playwright-controlled browser), which is much harder to detect. If you still hit it:
  1. Make sure **Google Chrome is installed** (not just Edge).
  2. **Close the bot's Chrome window**, delete the `browser-data` folder, and try **Sign in to
     Target** again so it starts from a clean profile.
  3. *"Couldn't start Chrome with a debugging port"* → another Chrome is already using the
     bot's debug port; close extra Chrome windows and retry.
  4. Sign in **slowly and normally** (type, move the mouse) — Target watches behavior. Avoid a
     VPN/proxy during sign-in.
  5. Once you're signed in successfully, the session is saved to `browser-data`; you usually
     won't need to log in again.
- *"No config.json found"* → run the `copy` step above.
- *Stock check 4xx* → rotate the `apiKey` (see tips) or switch `monitor.mode` to `"browser"`.
- *Not logged in during checkout* → re-run `node src/index.js login`.
- *Checkout stops early* → check `./screenshots/`; selectors likely need an update.

## Disclaimer

Provided as-is for educational and personal use. Respect Target's Terms of Service and
applicable laws. The authors are not responsible for misuse, account actions, or failed
orders.
