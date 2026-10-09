---
name: tripezgo
description: Read and edit trips in the TripEZGo iPhone app through its MCP server — itinerary events and travel legs, to-dos, attachments, notes, shopping list, map markers, trip info, and creating new trips. Use when the user asks to plan, build, change or review a trip in TripEZGo.
---

# TripEZGo

TripEZGo is a travel-planning iPhone app: one trip at a time, a day-by-day calendar of events, travel legs
between events, and to-dos, files, notes, a shopping list and map markers attached to the trip. The `tripezgo`
MCP server **is the app itself**, reachable only while the phone shows the "連接電腦 AI" (connect computer AI)
page on the same Wi-Fi. If every call fails to connect, ask the user to open that page again and keep the app
in the foreground.

> This skill is a first skeleton and will be refined.

## Start here

1. `list_trips` — see what exists. Calls without `tripId` go to the app's **default trip**: the one open on the
   user's phone ("this trip" / "the current trip" means it). `create_trip` makes the new trip the default — and
   the trip the phone shows — whichever way the user opened the page.
2. Pick the trip with the user; pass its `tripId` explicitly from then on.
3. `get_trip`, then `list_events` (optionally `from` / `to`) to see the itinerary and its legs before changing
   anything.

## Formats

- Dates: `YYYY-MM-DD`. Times: `HH:mm`, 24-hour, **in the trip's own time zone** (see `get_trip`) — not the
  computer's.
- Days: `dayNumber` (day 1 is the first day) or a `date` inside the trip. A trip whose dates are undecided only
  takes `dayNumber`.
- Legs belong to the event travelled to: `set_leg` / `clear_leg` take its `eventId`. For the leg into a day's
  closing all-day event (e.g. back to the hotel), pass `fromEventId` too.
- A leg's `durationMinutes` is `null` when the user never gave one (the app estimates it from the map).
- Ids (`tripId`, `eventId`, `placeId`, …) come from earlier tool results. Never invent one.
- Event kinds and shopping categories are enums in the tool schemas — use one of the listed values.
- Notes accept a small Markdown subset: `#` headings and `-` lists. Notes have no checkboxes — `- [ ]` / `- [x]` is refused; put things to tick off in to-dos (`create_todo`).

## Places

- **Events and map markers:** `search_place`, then pass its `placeId` to `create_event` / `update_event` /
  `create_marker` / `update_marker`. If the candidates look unrelated, retry with the place's English or
  local-language name.
- An event may take only a `placeName` (no map point unless it reads like an address the app can find).
- **A marker must have a point:** a `placeId` from `search_place`, or `latitude` + `longitude`. A name alone
  is refused.
- **A trip's main place** (a city or region, with its time zone) comes from `search_trip_place`; pass its
  `placeId` to `create_trip` / `update_trip`.

## Attachments

- A file on this computer: `add_attachment_from_path` — only when you are connected through this `TripEZGo/mcp`
  bridge (the Claude Desktop setup); up to 20 MB, the limit the app states. Without it, ask the user to make
  the file smaller than 5 MB or to connect with the Claude Desktop setup.
- Small generated content: `add_attachment` (base64, up to 5 MB).
- Without `eventId` the file hangs on the trip itself. A leg's attachment is `eventId` (the event travelled to)
  plus `fromEventId`.

## Be careful

- **Confirm with the user before any delete** (`delete_event`, `delete_todo`, `delete_note`,
  `delete_shopping_item`, `delete_marker`, `clear_leg`, `detach_attachment`). The app does not ask on the
  phone; it only lists what you did.
- Editing or moving one event shifts nothing else. Re-check the day with `list_events` after bulk changes.
- Check `canEditContent` (events, legs, to-dos, shopping, markers, attachments, notes) and `canEditTripInfo`
  (name, dates, main place, time zone) on the trip first. The demo trip and read-only shared trips allow
  neither; a trip someone else shared allows content only. The app answers a refused write with an error saying
  why — tell the user rather than retrying.
- Notes have no checkboxes; a thing to tick off is a to-do.
- Creating a trip can hit the user's trip limit; report the error as-is.
