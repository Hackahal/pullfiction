# Find a run and keep your plans

The Library opens when Pull Fiction starts. Use **My plans** for planning work,
**Recent runs** for saved analysis sessions, and **Find logs** to browse Warcraft Logs.
The editor stays mounted when you open the Library.

## Choose a log

1. Open **Find logs** and select Classic Era or Season of Discovery.
2. Connect Warcraft Logs.
3. Select **Find guild**. Enter the full guild name, select a region, then choose a realm from the
   dropdown. Select **Find guild** in the search form. Its recent runs load automatically.
4. Select **Save guild** to keep it in this browser. Selecting a saved guild
   loads its latest runs. Pull Fiction remembers the last saved guild you selected.
   Era and SoD guild selections are kept separately.
5. Use **Raid** and **Date** to filter the guild's runs. These filters apply to
   the Warcraft Logs query, including older pages. Use **Older** and **Newer**
   to browse the results.
6. Select a run to preview its pulls. This retrieves report metadata, not its
   combat event stream. Filter the preview to bosses, kills or trash, or search by name.
7. Choose a full run or one encounter. Select **Analyse** or **Create plan**,
   then open it. Select your local client folder when prompted.

For any other run, paste its Warcraft Logs URL or report code into
**Open a run link** and select **Open**. No guild selection is required.
The **Saved** button on the selected guild removes it from saved guilds;
this does not delete any local projects or imported logs.

Creating a plan from a log freezes the starting actor positions through the
existing planning tools. You can also analyse a run, pause at a useful moment,
and use **Plan from this moment**. A new blank plan starts through **My plans → New plan**.

Warcraft Logs discovery uses its documented user and guild report collections.
It does not provide an assumed global report-title search. See the official
[ReportData schema](https://tw.warcraftlogs.com/v2-api-docs/warcraft/reportdata.doc.html).
The editor can open the instances its current replay adapters support.

## Save and reopen

Committed edits autosave after a short pause. **Saved locally** appears only
when the IndexedDB write transaction completes. **Save** and the existing save
shortcut force a checkpoint. Pausing or seeking checkpoints the playback position.

Each project has its own identity. Several plans can use the same raid and log
without sharing edits. **Duplicate plan** makes an independent copy and reuses
its immutable cached source. Switching projects resets the current undo history.
Existing per-raid saves are copied into the Library without deleting their old keys.

The source replay is stored separately from edits. Changing a note or drawing
never rewrites the entire replay. A source snapshot belongs to one actual import;
a later import of an updated report cannot overwrite a previously saved source.

Select a saved project to reopen it. Its pages, notes, actor placements, source,
workspace mode and saved playback position return. If the log is cached, reopening
needs no Warcraft Logs connection. After a page reload you still select the local
game client again; browser file selection is separate from project persistence.

**Cached** in the source column means a full-file replay is stored locally.
**Streamed source** uses individually cached sections and may be incomplete.
See [buffered replay](BUFFERED-REPLAY.md) for loading and offline coverage. If the
source is missing, the plan still opens. Connect Warcraft Logs and use **Reload source log**
to restore the source without replacing your edits.

## Keep a portable backup

Use the download action on a project, or **File → Export project backup**.
The `.pullfiction.json` file contains all plan edits and source metadata, plus
the cached replay when available and within the 150 MB import limit. A streamed
replay backup includes its downloaded sections and coverage; other sections
need Warcraft Logs unless the full run was downloaded. For a larger
source, the backup keeps its link and all edits; the application reports that the
source must be reloaded. Game models, textures and client files are never included.

**Import project** restores a backup as a separate project and opens it. It also
accepts older exported plan JSON files. Importing a backup does not overwrite an
existing plan with the same name. If caching its source fails, the smaller plan
can still be imported.

When local saving fails, the editor keeps the dirty edits and blocks project/map
switches that would discard them. Exporting a backup uses the current in-memory
edits, so it remains available when the primary save has failed.

## Manage local work

The trash action moves a project to **Trash**. Use **Restore** to recover it.
There is no permanent-delete action in this version. Cached sources remain local
so deleting one of several plans cannot remove a source used by another.

Projects and cached logs belong to this browser and site origin. They do not automatically sync
to an account or another device. To send a fixed snapshot of edits and its Warcraft Logs
reference to someone else, use [Share](SHARING.md). Clearing site data removes them, so export the
projects you want to keep outside the browser. Warcraft Logs tokens remain in
memory and are not included in projects or backups.
