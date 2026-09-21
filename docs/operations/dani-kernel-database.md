# Dani kernel database recovery

The Dani execution kernel uses a versioned SQLite database with foreign keys, WAL, `synchronous=FULL`, and a five-second busy timeout.

## Upgrade

On startup, the repository reads `PRAGMA user_version`. Before any schema upgrade of an existing database, it creates a consistent SQLite snapshot beside the database:

`<database>.pre-v<old>-to-v<new>-<timestamp>.sqlite`

The migration runs in one immediate transaction. Keep the snapshot until the upgraded app has completed a clean job and restart-recovery check.

## Downgrade or restore

The kernel refuses to open a database whose schema version is newer than the running app. Do not edit `user_version` by hand.

1. Stop Dani completely.
2. Preserve the current database plus its `-wal` and `-shm` files for diagnosis.
3. Move the current database, `-wal`, and `-shm` out of the data directory.
4. Copy the matching `pre-v...sqlite` snapshot to the configured database path.
5. Start the older app and inspect the kernel event log before allowing effects.

A job or effect left in `dispatching` or `verifying` is marked `uncertain` on restart. It must be inspected through its adapter and must not be retried automatically.
