# Archived migrations

The original 001–037 migrations, in the order they were applied. They are
superseded by `../01_guild_and_access.sql` through `../06_war_record.sql`,
which hold the same schema in its final state. Each section header there names
the archived numbers it replaces ("was 013, 036").

Kept for the reasoning in their headers. Code comments that say "migration 019"
mean the file here.

Don't run these on a new database — run 01–06 instead. The one exception is a
database that stopped partway through this sequence: finish it from here, or
just run 01–06, which are safe to re-run over any of these.
