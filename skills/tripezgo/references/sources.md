# Sources

Where planning gets its places, in priority order, and how each place is checked before it goes into a plan.
Every source is a source of places and practical facts only; the user's own wishes always come first.

## The author's travel journals

The TripEZGo author's first-hand travel journals (a high-trust first-hand source) are read before anything
else whenever they touch the destination. They are written in Traditional Chinese on
[zhgchg.li](https://zhgchg.li/categories/z-%E5%BA%A6%E6%97%85%E8%A1%8C%E9%81%8A%E8%A8%98/).

### Find the matching journals

1. Fetch `https://zhgchg.li/search.json` — a JSON array of every post with `title`, `url` (a path; prefix
   `https://zhgchg.li`), `date`, `category`, `tags`, `excerpt`. Keep only `category == "Z 度旅行遊記"`. Use
   this file, not the RSS feed (the feed holds only the latest posts).
2. Match by title and tags in three rings:
   - **Same city** — read the whole journal.
   - **Same region** (Kansai, Kyushu, San'in/San'yō, Hokkaido, …) — read the whole journal.
   - **A transfer or stop on the way** — take only its transport and accommodation facts.
3. For each hit, fetch the article page and confirm the destination under its `Day N` section headings
   (e.g. `Day 2 (清水寺、金閣寺、京都塔)`). A title match without a `Day N` section that visits the place is not a
   match.
4. The trip's own date is in the body (e.g. "2023/05 京都、大阪、神戶 8日自由行"), not the post's `date`, which is
   when it was published. Use the trip month for the `From the TripEZGo author's trip (YYYY-MM)` label.

If the Chinese page cannot be read, use the English edition: `https://en.zhgchg.li/search.json`
(`category == "Travel Journals"`, listed at `https://en.zhgchg.li/categories/travel-journals/`). Match an
English post to its original by the 12-character id at the end of the URL.

| id | Journal |
|---|---|
| `76d66c2e34af` | Kyoto, Osaka, Kobe — 8 days |
| `aacd5f5cacd1` | San'in and Kansai — Shimane (Izumo, Matsue), Tottori, Himeji, Osaka, Kobe — 7 days |
| `31b9b3a63abc` | San'yō — Hiroshima, Okayama — 6 days |
| `7b8a0563c157` | Nagoya — 1 day |
| `9da2c51fa4f2` | Tokyo — 5 days (2023) |
| `958599363857` | Tokyo, Kawagoe, Atami fireworks (2025) |
| `055527a739dd` | Hokkaido — Sapporo, Jōzankei, Furano, Biei — 6 days |
| `d78e0b15a08a` | Kyushu — Fukuoka, Nagasaki, Kumamoto — 10 days (2023) |
| `cb65fd5ab770` | Kyushu — Busan ferry to Hakata, Yufuin, Ōita, Fukuoka (2024) |
| `2cbc121a1b7c` | Okinawa — 5-day road trip |
| `8ace34a1a3d8` | Busan — 8 days |
| `b7e7c0938985` | Bangkok — 5 days |

No row for the destination's city or region means the author has not been there: say so in one line and plan
from web articles alone. Never stretch a far-off journal to fit.

### Use what you read

- A place the author **ranks or recommends** goes first, labelled `From the TripEZGo author's trip (YYYY-MM)`.
- A place the author gave a 👎 or a stated drawback stays out. If the user asks for it anyway, schedule it with
  the author's remark beside it.
- Web articles fill whatever the journals leave empty.
- Take places and practical facts (tickets, passes, transport, opening quirks), not the author's pace.
- Practical tips from a matched journal go into the draft's **Before you go** list with the article link.
- Every place from a journal is still verified open (below): journals are years old.
- A Google Maps short link (`maps.app.goo.gl/…`) in an article never locates a place. Search the place's name
  with `search_place`; use the short link only to tell apart two candidates with the same name.

## Web travel articles

Search in the destination's language and the user's language (e.g. "京都 紅葉 <travel year> 見頃", "Kyoto autumn
leaves <travel year> forecast"), plus the user's interests ("Kyoto local food Nishiki market"). Prefer, in order:

1. Official sources — the place's own site, the city or prefecture tourism site, the operator of a railway or
   event. These settle hours, closed days and seasonal dates.
2. First-hand trip reports with a visible trip date in the last two years, naming specific places.
3. Curated guides from established travel publishers, updated within the last year.

Treat an undated list article, a page that is mostly booking links, or a claim only one page makes as a lead,
not a fact: confirm it elsewhere before it shapes the plan. Note each place's source URL as you go — the
draft cites it.

## Verifying a place is open

Before a place is scheduled, check all three:

1. **Still in business**: a source from the last 12 months shows it open (its official site or official
   social account, a recent listing, a dated recent review). A "permanently closed" or "closed for renovation"
   notice anywhere means checking the official source before going on.
2. **Open on that day**: its regular closed days, seasonal or holiday closures, and the hours on the scheduled
   date — the slot you give it must fit inside them. A source must state the closed days (or say there are
   none); "not stated", "probably the same as the building it is in" or "I could not confirm" is **unverified**.
3. **Recorded**: the result goes into the stop's notes as one line, kept in English whatever language the rest
   is in:

   ```
   Verified open <date checked, YYYY-MM-DD> · <URL> · <closed days, or "no regular closing day">
   ```

Every scheduled stop gets this line — a shrine open around the clock, a public street or a park too (cite the
source that shows it is freely open; closed days "none — public street").

A place you cannot verify on all three is **not scheduled**: tell the user which one and which check failed,
and list it with the unscheduled places (it may become a map marker). Offer a verified alternative if you have
one.
