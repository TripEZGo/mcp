---
name: tripezgo
description: Plan trips and work in the TripEZGo iPhone app through its MCP server. Use when the user wants a trip planned or an itinerary drafted (any destination), or wants to read or change anything in TripEZGo — trips, events, legs, to-dos, notes, markers, shopping list, attachments — or pastes a TripEZGo connect sentence in any of its languages: 「連接 TripEZGo：IP:PORT，金鑰 …」, 「连接 TripEZGo：IP:PORT，密钥 …」, "Connect to TripEZGo: IP:PORT, key …", 「TripEZGo に接続：IP:PORT、キー …」, "TripEZGo 연결: IP:PORT, 키 …".
---

# TripEZGo

TripEZGo is a travel-planning iPhone app: one trip at a time on the phone, each with a day-by-day calendar of
events, travel legs between events, and to-dos, files, notes, a shopping list and map markers. The `tripezgo`
MCP server reaches the app on the user's iPhone over the same Wi-Fi, and through it **all** of the user's trips.

## Connecting

The server starts unconnected; nothing about the phone is in its configuration. It connects in the
conversation:

- **The user pastes a connect sentence**, in whichever language the phone uses — call `connect` right away
  with `address` = the `IP:PORT` part and `token` = the key:

  | Language | Sentence |
  |---|---|
  | 繁體中文 | 連接 TripEZGo：192.168.1.23:8765，金鑰 abc123 |
  | 简体中文 | 连接 TripEZGo：192.168.1.23:8765，密钥 abc123 |
  | English | Connect to TripEZGo: 192.168.1.23:8765, key abc123 |
  | 日本語 | TripEZGo に接続：192.168.1.23:8765、キー abc123 |
  | 한국어 | TripEZGo 연결: 192.168.1.23:8765, 키 abc123 |
- **A TripEZGo tool answers "Not connected"**, or the user asks for anything in TripEZGo before connecting: ask
  the user to open TripEZGo on the iPhone › Settings › 用電腦 AI 編輯 (the "Connect computer AI" page; for a new
  trip, New trip › 用電腦 AI 建立旅程), keep that page open, and paste the sentence it shows. Then `connect`.
- **A tool says the connection ended** (the page was closed or reopened): ask for the sentence again and call
  `connect` with the new one. Calling `connect` again always replaces the old connection.
- **Can't reach the app**: the phone must stay on that page with TripEZGo in the foreground, on the same Wi-Fi
  as this computer. If the page now shows a different address or a new sentence (the Wi-Fi changed, or the
  page was reopened), ask the user to copy the latest sentence from the iPhone and paste it again.
- **A tool "doesn't exist yet" in the app**: the iPhone's TripEZGo is older than this server — tell the user to
  update it from the App Store.

`get_planning_guide` (this guide, served by the server for clients that have no skills folder) works without
a connection.

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

**Attachments.** A local file: `add_attachment_from_path` (it reads the file on this computer; up to
20 MB, or the limit the app states when you connect). Small generated content: `add_attachment` (base64, up to 5 MB). A new attachment hangs on the trip or
on one event, never on a leg.

**Deletes.** Confirm with the user before any `delete_*`, `clear_leg` or `detach_attachment` — the phone does
not ask; it only lists what you did. Editing or moving one event shifts nothing else; re-read the day with
`list_events` after bulk changes. Creating a trip can hit the user's trip limit; report that error as-is.
