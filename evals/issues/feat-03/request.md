# Feature 03: ReadOnlyMiddleware storage middleware

Please implement a `ReadOnlyMiddleware` class in `tinydb.middlewares` and export it in `tinydb`.

### Requirements:
1. `class ReadOnlyMiddleware(Middleware)`:
   - Inherits from `tinydb.middlewares.Middleware`.
   - Allows reading data from storage normally via `read()`.
   - Disallows all write operations: calling `write()` must raise a `PermissionError("Cannot write to read-only storage")`.
2. Export `ReadOnlyMiddleware` in `tinydb/middlewares.py` and `tinydb/__init__.py`.
3. Writing to a TinyDB instance configured with `ReadOnlyMiddleware` (such as `insert`, `update`, `remove`, `truncate`) must raise `PermissionError`.
4. Ensure zero external dependencies and backward compatibility with all existing TinyDB storages and middlewares.
