---
version: 1
slug: "app"
primary_target: "app"
related_targets: ["components"]
---

Scope: the Tandem web dashboard (all authenticated screens plus sign-in). Mode: Operate.
Audience and job: small-team members at daytime desks find, edit and save canonical files their teammates' assistants also write; they must always see who changed what.
Pinned by the user: the left rail is white (not slate). Everything else in the assigned sketch was approved as-is.

## Direction contract

THESIS: Every file carries its chain of custody like an archived object. Refuses the neutral SaaS file table with pill badges.

OWN-WORLD: Cool acid-free grey ground (#f3f4f2), white paper panels with 1px rules, ink #1c2226. Archive slate #3b4f5c for the mark, selection tint and focus. Accession red #b4321f only on pressable primary actions. Agents in verdigris #2f7a6d with square marks; humans in ink-blue #2b5a8a with round marks. Public Sans for UI; Archivo Narrow caps for catalogue labels, accession numbers and version tags. 4px radius, 1.2 type scale, 4px rhythm.

STORY: The visitor sees what changed and who held each file, opens it, edits, and saves knowing nothing is lost.

FIRST VIEWPORT: White rail (mark, workspace, Files with count, Assistants note at the foot). Top bar with breadcrumb and user. Files heading with record count and red "New file". The register table (No., Name, Custody strip, Last held by, Updated) on the left. The Custody record panel for the selected file on the right, with an Open file action.

FORM: Archive accession register / provenance record, position 6 of 7 on the grounded list. seed:3d348ad3b4677292

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Signature interaction: the custody strip. One fixed mark per version (head mark one size larger), shaped and coloured by actor. Selecting a row reveals its custody record without leaving the register.
Raises kept from the declined challengers: fixed mark scale (star atlas), registered comparison frame for history (botanical folio), one identity plate per actor everywhere (character catalog), red reserved for actions (consumer canon), strict baseline rhythm (type specimen).
Unresolved: real accession numbering needs a backend field; the build derives a stable display ID from the file ID.
