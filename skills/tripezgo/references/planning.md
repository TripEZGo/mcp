# Planning a trip

The flow from "plan me a trip" to an approved draft. Each step ends on the condition written after **Done
when**; move on only then. Writing the approved draft into the app is
[`writing-to-the-app.md`](writing-to-the-app.md). How to find and judge sources is
[`sources.md`](sources.md) — steps 5–7 need it.

Talk to the user in their own language throughout. This file is English; the conversation and everything
written into the app are not.

## 1. Web search is on

Planning rests on live sources: places close, hours change, seasonal events move every year. Check that you
have a web search tool **and** a way to read pages (a fetch tool) before anything else.

Without them, decline to plan: say that trip planning needs web search and ask the user to turn it on (or
start a client that has it). You may still write places the user names themselves (a hotel they booked, a
flight they hold) — those need no search.

**Done when** you have run one search and read one page in this session, or have declined.

## 2. Ask once, all seven

Before researching, you need seven things. Ask in **one** message for every one the user has not given:

1. Destination
2. Dates (or number of days, if dates are undecided)
3. Who is travelling (adults, children, seniors)
4. Pace: relaxed, normal or packed
5. Interests
6. Fixed points already booked: flights, accommodation, tickets
7. Must-go places and places to skip

Leave budget out unless the user brings it up. When the user's message covers most of the list and is silent
on an optional item (bookings, places to skip), treat it as "none" and state that assumption at the top of the
draft instead of asking again.

If the request as given already breaks the pace limits in step 8 (say, eight sights in one day), say so in
this same message and lay out the choice (see step 8) — the user decides, not you.

**Done when** all seven are answered or explicitly assumed.

## 3. Pin the destination and its time zone

Call `search_trip_place` with the destination and pick the candidate that matches; its time zone is the trip's
time zone. Never work out a time zone yourself. A city spread across several zones is not offered — pick a city
in it. A leg of the trip in another zone gets `eventTimeZone` on its events later.

**Done when** you hold a trip `placeId` and its IANA time zone.

## 4. The season of the travel dates

Search for what is in season **on the travel dates** — festivals, blossoms and autumn leaves, illuminations,
seasonal openings and closures — for **that year**. Seasonal dates move: look up this year's forecast or
schedule (e.g. this year's autumn-leaves forecast, this year's festival date), never last year's.

If the dates are undecided, use today's date and tell the user to have the season re-checked once dates are
set.

**Done when** you can name the seasonal highlights for the dates with a current-year source for each, or know
there are none worth planning around.

## 5. The author's journals first

Check whether the TripEZGo author's first-hand travel journals cover the destination, its region, or a
transfer point on the way — the exact procedure, the article list and how to weigh what you find are in
[`sources.md`](sources.md) § The author's travel journals. They are a high-trust first-hand source, ranked
first among sources; they never override what the user asked for.

**Done when** you have either read every matching journal (same city and same region in full) or confirmed
from `search.json` that none matches.

## 6. Web travel articles fill the gaps

Search recent travel articles and trip reports for the destination and the user's interests, and collect
candidate places with what makes each worth it. How to search and judge them: [`sources.md`](sources.md) §
Web travel articles.

**Done when** you have more candidates than the days can hold, each tied to a source URL.

## 7. Every place verified open

Verify each candidate you intend to schedule: still in business, open on the day you would put it, and its
hours. The three checks and the note format are in [`sources.md`](sources.md) § Verifying a place is open.
A place you cannot verify is left out of the plan, and you tell the user which and why.

Then `search_place` each kept place (pass `near` with the previous stop's coordinates when the default search
misses). Its coordinates are what you measure travel time from. A place `search_place` cannot find is named in
the draft as not found on the map.

**Done when** every scheduled place has a verification line and a `placeId` (or is flagged as not found).

## 8. Lay out the days

Build each day around the user's pace and the real distances between places. Use the author's pacing only as
information, never as the default — the default pace is **normal**.

Limits at normal pace (loosen for packed, tighten for relaxed):

- At most **4 main sights** a day. Meals and places on the way don't count.
- Travel at most **30%** of the day's active time.
- Flag any single leg over **90 minutes**.
- Nothing starts before **09:00** or after **21:00**.
- At least **15 minutes** of buffer between places.
- Respect fixed points (flights, check-in, timed tickets) and each place's hours on that day.

Get travel times from a route search or the place's official access page, not from guesswork.

**When a day breaks a limit**, stop and show that day to the user: the places, the travel times, which limit
it breaks, and two or three ways out (drop one, move one to another day, swap for something nearer). Ask which.
Never drop or squeeze a place on your own — least of all a must-go.

**Done when** every day is inside the limits or the user has chosen how to handle the ones that are not.

## 9. The draft, in the conversation

Give the user a day-by-day draft. For each day:

- Each stop: time, place ("name in the user's language (local name)"), what to do there, how to get there and
  how long it takes.
- Under each stop, its verification line exactly as [`sources.md`](sources.md) shapes it — in English, word for
  word `Verified open <date> · <URL> · <closed days>`, even when everything around it is in another language.
- Stops the author recommended carry `From the TripEZGo author's trip (YYYY-MM)`, the month of the trip itself.
- Places you researched but did not schedule, with the reason (they become map markers on writing). Only
  places not already in the plan go here; an extra option at a scheduled place (a night viewing, a special
  opening) goes in that stop's notes instead.

After the days, a **Before you go** list: only the practical tips the matched journals and articles actually
gave for this trip (each with its link), marked as time-sensitive (book, buy or apply by a date) or not. No
generic packing or etiquette list.

End by asking whether to write it into TripEZGo, and into which trip (a new one, or an existing one from
`list_trips`).

**Done when** the user approves the draft. Any later change is shown the same way and approved before it is
written.

## 10. Write it

Follow [`writing-to-the-app.md`](writing-to-the-app.md).
