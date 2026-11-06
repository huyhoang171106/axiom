# Feature 02: Limit parameter for search

Please add an optional `limit` parameter to `search()` on both `Table` and `TinyDB`.

### Requirements:
1. `Table.search(self, cond: QueryLike, limit: Optional[int] = None) -> list[Document]`:
   - If `limit` is a positive integer, return at most `limit` matching documents in insertion order.
   - If `limit <= 0`, return an empty list `[]`.
   - If `limit is None` (the default), return all matching documents (preserving existing behavior).
2. `TinyDB.search(self, cond: QueryLike, limit: Optional[int] = None) -> list[Document]`:
   - Delegates to the default table with the `limit` argument.
3. Update signatures and docstrings in `tinydb/table.py`, `tinydb/database.py`, and `tinydb/__init__.py`.
4. Ensure zero external dependencies and backward compatibility with all existing tests.
