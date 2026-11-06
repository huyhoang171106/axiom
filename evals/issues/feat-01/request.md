# Feature 01: Table and TinyDB count_where

Please implement a `count_where(cond)` method on both `Table` and `TinyDB`.
This allows counting documents matching a query condition efficiently without constructing the full list of matching documents.

### Requirements:
1. `Table.count_where(self, cond: QueryLike) -> int`:
   - Returns the integer count of documents in the table that satisfy `cond`.
   - If no documents match, returns 0.
2. `TinyDB.count_where(self, cond: QueryLike) -> int`:
   - Delegates `count_where` to the default table.
3. Expose or document `count_where` cleanly in `tinydb/__init__.py`, `tinydb/database.py`, and `tinydb/table.py`.
4. Keep zero external runtime dependencies and maintain full backward compatibility with existing TinyDB APIs.
