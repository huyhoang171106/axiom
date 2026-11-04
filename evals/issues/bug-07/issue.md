# Search results change after I edit a list returned by an earlier search

In a web handler I run the same `db.search(...)` query on every request and then trim the returned list in place (`results.pop()` / `results.clear()`) before rendering it.
After a few requests the same query starts returning fewer documents, and finally an empty list, although nothing was removed from the database: `len(db)` and `db.all()` still show every document.
Restarting the process makes the results correct again until the next requests.

The first search after start-up is always right; it goes wrong from the second identical search on.
The existing test suite passes, so nothing seems to cover this.
