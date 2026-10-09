# Writing to the app

How an approved draft (or any requested change) becomes data in TripEZGo. Write exactly what the user
approved. When part of the draft cannot be written as drafted, or you think of a change while writing, ask
the user before writing that part any other way.

## Language and names

- Titles, notes, to-dos and markers are in the language the user writes to you in.
- A place's title is `<name in the user's language> (<local name>)` — `清水寺 (清水寺)` collapses to `清水寺`;
  `Kiyomizu-dera (清水寺)` for an English speaker; `二條城 (二条城)` for a Traditional Chinese speaker.
- Source links stay as the original URL.
- The verification line keeps its fixed shape: `Verified open <date> · <URL> · <closed days>`.

## Order of calls

1. **The trip.**
   - New trip: `create_trip` with `name`, `startDate` + `endDate` (or `dayCount`), and the `placeId` from
     `search_trip_place`. Its time zone follows the place; leave `timeZone` out.
   - Existing trip: `list_trips` → `get_trip`. Check `canEditContent` (and `canEditTripInfo` if its dates or
     place must change), then `update_trip` with only what changes. `list_events` first: the trip may already
     hold events the plan must fit around or the user must decide about.
   - Confirm from the result that `timeZone` is the destination's (e.g. `Asia/Tokyo`).
2. **Fixed points.** Flights (`eventTimeZone` / `endTimeZone` when the ends differ), the hotel (an all-day
   `lodging` / `hotel` event over the nights, `date` … `endDate`), timed tickets. A place the user named
   themselves may go in by `placeName` without a search.
3. **Each stop**, day by day, in time order: `create_event` with
   - `placeId` from `search_place` (re-run `search_place` if the link was reopened since you searched — ids last
     for one link);
   - `date` or `dayNumber`, `startTime`, `endTime` or `durationMinutes`;
   - `title` as above, `type` from the schema (`temple`, `dining`, `market`, `viewpoint`, …);
   - `notes`: what to do there, the `Verified open …` line, the `From the TripEZGo author's trip (YYYY-MM)`
     label if it applies, and any tip that concerns this stop only (with its link).
4. **Legs**: `set_leg` on each event you travel **to** — `mode` (`walking`, `transit` + `transitKind`,
   `driving`, …), `durationMinutes` from your route research, a short `note` ("Kyoto City Bus 206 toward
   Kitaōji"), `routeUrl` when you have one. Leave `durationMinutes` out when you only have an estimate — the
   app estimates from the map. The leg into the closing hotel takes `fromEventId` (the day's last stop).
   A day's first stop has no event before it: with a hotel event, its leg takes `fromEventId` (the hotel);
   without one, it gets no leg, and the way there goes in the first line of its notes.
5. **To-dos** for time-sensitive reminders from the draft's Before you go list (book, buy, apply by a date):
   `create_todo`, with `eventId` when it belongs to one stop ("Reserve the 11:00 slot online"), without it for
   a trip-wide one ("Buy the Kansai rail pass before departure"). Put the source link in the title when it fits,
   otherwise in that event's notes.
6. **Markers** for places researched but not scheduled (dropped for time, a maybe, an alternative for rain):
   `search_place` → `create_marker` with `placeId`, `type`, and `notes` saying why it is there and its source.
7. **A note** (optional, when the user wants one): `create_note` with the sources and the Before you go items
   that are not to-dos — headings and `-` lists only, no checkboxes.
8. **Read it back**: `list_events` for the whole trip; check every day's order, times and legs against the
   draft, then tell the user what was written (and anything that was refused, with the app's reason).

## Changes after writing

Show the change and get a yes before writing it. Use `update_event` / `set_leg` with only the fields that
change; `cancelled: true` keeps a stop on the calendar struck through when the user is unsure. Deleting
anything needs the user's explicit confirmation (see the operating rules in `SKILL.md`).
