---
name: tripezgo
description: Plan trips and work in the TripEZGo iPhone app through its MCP server. Use when the user wants a trip planned or an itinerary drafted (any destination), or wants to read or change anything in TripEZGo — trips, events, legs, to-dos, notes, markers, shopping list, attachments.
---

# TripEZGo

TripEZGo is a travel-planning iPhone app: one trip at a time on the phone, each with a day-by-day calendar of
events, travel legs between events, and to-dos, files, notes, a shopping list and map markers. The `tripezgo`
MCP server **is the app itself** and reaches **all** of the user's trips. It answers only while the phone shows
the "連接電腦 AI" (connect computer AI) page on the same Wi-Fi; if every call fails to connect, ask the user to
open that page again and keep the app in the foreground.

## Route

| The user wants | Read |
|---|---|
| A trip planned, an itinerary drafted, places suggested for a destination | [`references/planning.md`](references/planning.md) — the whole planning flow, start to finish |
| (inside planning) the author's travel journals, web articles, checking a place is open | [`references/sources.md`](references/sources.md) |
| An approved plan written into the app, or any edit to a trip | [`references/writing-to-the-app.md`](references/writing-to-the-app.md) |

Planning always ends in a draft the user approves in the conversation; nothing is written to the app before
that approval.

## Operating rules

These hold for every call, planning or not.

**Which trip.** `list_trips` first. Calls without `tripId` go to the link's **default trip** ("this trip").
Opened from Settings, the default is the trip open on the phone; opened from adding a new trip, there is no
default — `create_trip` first or pass `tripId`. `create_trip` makes the new trip the default and the trip the
phone shows. Once a trip is chosen, pass its `tripId` explicitly. Read it with `get_trip` and `list_events`
before changing it.

**Permissions.** `canEditContent` gates events, legs, to-dos, shopping, markers, attachments and notes;
`canEditTripInfo` gates name, dates, main place and time zone. The demo trip and read-only shared trips allow
neither; a trip someone else shared allows content only. A refused write answers with why — tell the user
rather than retrying.

**Formats.** Dates `YYYY-MM-DD`; times `HH:mm`, 24-hour, in the **trip's** time zone (from `get_trip`), never
the computer's. Days are `dayNumber` (day 1 = first day) or a `date` inside the trip; a trip with undecided
dates takes only `dayNumber`. Ids come from earlier tool results — never invent one. Enums (event types,
shopping categories, leg modes) are listed in the tool schemas.

**Places.** A trip's main place (city or region, with its time zone): `search_trip_place` → `placeId` to
`create_trip` / `update_trip`. An event's or marker's place: `search_place` → `placeId`; if the candidates look
unrelated, retry with the English or local-language name. A marker needs a point (`placeId`, or latitude +
longitude). `placeId`s last for the current link only.

**Legs.** A leg belongs to the event travelled **to**: `set_leg` / `clear_leg` take its `eventId`. For the leg
into a day's closing all-day event (back to the hotel), pass `fromEventId` too. `durationMinutes: null` means
the app estimates it from the map.

**Notes and to-dos.** Notes take a Markdown subset: `#` headings and `-` lists, no checkboxes. Anything to
tick off is a to-do (`create_todo`), on an event (`eventId`) or trip-wide.

**Attachments.** A local file: `add_attachment_from_path` (only through the `TripEZGo/mcp` bridge; up to
20 MB). Small generated content: `add_attachment` (base64, up to 5 MB). A new attachment hangs on the trip or
on one event, never on a leg.

**Deletes.** Confirm with the user before any `delete_*`, `clear_leg` or `detach_attachment` — the phone does
not ask; it only lists what you did. Editing or moving one event shifts nothing else; re-read the day with
`list_events` after bulk changes. Creating a trip can hit the user's trip limit; report that error as-is.
