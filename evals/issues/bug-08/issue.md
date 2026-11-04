# Searches return stale documents after an update or after dropping a table

Two things look related: repeated searches keep returning old data.

```python
from tinydb import TinyDB, Query

db = TinyDB('shop.json')
Item = Query()
db.insert({'name': 'pen', 'price': 2})
print(db.search(Item.name == 'pen'))      # [{'name': 'pen', 'price': 2}]
db.update({'price': 3}, Item.name == 'pen')
print(db.search(Item.name == 'pen'))      # still price 2, expected price 3
print(db.get(Item.name == 'pen'))         # price 3, so the data itself was updated

events = db.table('events')
events.insert({'kind': 'start'})
print(events.search(Item.kind == 'start'))                  # [{'kind': 'start'}]
db.drop_table('events')
print(db.table('events').search(Item.kind == 'start'))      # still [{'kind': 'start'}], expected []
```

`db.all()` and `db.get(...)` are correct in both cases; only repeated `search` calls are wrong.
Reopening the file gives the right results.
