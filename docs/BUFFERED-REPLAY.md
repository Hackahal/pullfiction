# Buffered replay

Opening a Warcraft Logs run downloads its roster, ability metadata and encounter
boundaries first. The detailed replay starts with a 60-second section. The run
navigator retains the complete duration and all encounter boundaries, so you can
scrub directly to a later boss.

The thin green strip in the navigator marks downloaded event ranges. Playback
prefetches the next section. Seeking to an unloaded section pauses the scene
while that section loads. The scrubber still shows the requested time. The 2D
map and Focus keep their last ready frame during loading.

## State at a seek

A distant seek also needs earlier buffs, deaths, summons and casting state.
Pull Fiction fetches the missing history with an event filter rather than
fetching all earlier damage and healing events. This history can still be large
on a long run, so the first distant seek may take longer than a cached seek.

Detailed sections include five seconds of surrounding events for interpolation
and cast reconstruction. Events belong to one section by timestamp. Identical
hits at the same timestamp are retained; overlapping requests do not double them.
Movement does not interpolate across sections that have not been downloaded.
Health and power do not carry across an unloaded gap as if they were current.
Positions still have the accuracy limits of the source log, including missing Z.

## Analysis while loading

Charts keep the full time axis. Unloaded sections appear as gaps. Curves are
built separately within loaded ranges. The chart total is labelled as a
downloaded total until the run is complete. Cumulative curves and totals so far
need all earlier detailed events. Analysis offers **Load this range** when its
selected range is incomplete. Cast search covers downloaded data.

Use **Download full run** beside playback controls to fetch everything for
complete analysis and offline use. **Stop download** cancels that background
operation. Scrubbing takes priority over a background download. **Retry section**
retries a failed playback request; reconnect to Warcraft Logs when required.

## Local saves and backups

Downloaded sections are cached individually in IndexedDB under an immutable
source snapshot. Editing a plan does not rewrite the event stream. A saved
project restores its cached sections before requesting missing data. Cached
sections remain usable without a Warcraft Logs session; uncached sections need
a connection.

The library labels these sources **Streamed source**. That label does not mean
the whole run is available offline. The download control disappears after the
complete detailed range is present in the current replay.

Project backups and replay exports include their downloaded sections and the
coverage metadata. Exporting a partial replay reports that other sections still
need Warcraft Logs. Project backups retain all edits regardless of source
coverage. Importing a project backup gives its stream a separate cache identity.
See [local projects](LOCAL-PROJECTS.md) for backup limits and storage boundaries.

Before adding network data to a cached source, the importer checks the report
revision, segment count and end time. It checks again before committing fetched
sections. If the report changed, use **Reload source** to start a new source
snapshot while retaining the project's edits.
