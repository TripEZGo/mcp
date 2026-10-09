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

1. `list_trips` — see what exists. Calls without `tripId` go to the app's **default trip** (the one the user
   opened the page from, or the trip you just created with `create_trip`).
2. Pick the trip with the user; pass its `tripId` explicitly from then on.
3. `get_trip`, then `list_events` (optionally `from` / `to`) to see the itinerary and its legs before changing
   anything.

## Formats

- Dates: `YYYY-MM-DD`. Times: `HH:mm`, 24-hour, **in the trip's own time zone** (see `get_trip`) — not the
  computer's.
- Ids (`tripId`, `eventId`, `placeId`, …) come from earlier tool results. Never invent one.
- Event kinds and shopping categories are enums in the tool schemas — use one of the listed values.
- Notes accept a small Markdown subset: `#` headings, `-` lists, `- [ ]` checkboxes.

## Places

Call `search_place` first and pass the returned `placeId` to `create_event` / `update_event` /
`create_marker`. Passing only a name works but gives no map location.

## Attachments

- A file on this computer: `add_attachment_from_path` (needs the `TripEZGo/mcp` bridge; up to 20 MB, the limit the app states).
- Small generated content: `add_attachment` (base64, up to 5 MB).
- Without `eventId` the file hangs on the trip itself.

## Be careful

- **Confirm with the user before any delete** (`delete_event`, `delete_todo`, `delete_note`,
  `delete_shopping_item`, `delete_marker`, `clear_leg`, `detach_attachment`). The app does not ask on the
  phone; it only lists what you did.
- Editing or moving one event shifts nothing else. Re-check the day with `list_events` after bulk changes.
- Some trips are read-only or shared with limited rights; the app answers with an error saying so — tell the
  user rather than retrying.
- Creating a trip can hit the user's trip limit; report the error as-is.
