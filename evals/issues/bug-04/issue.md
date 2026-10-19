# Document IDs keep counting after I clear the database

When I wipe the data and start over, new documents do not get ID 1 again. Two ways to reproduce:

```python
from tinydb import TinyDB

db = TinyDB('log.json')
db.insert_multiple([{'n': 1}, {'n': 2}, {'n': 3}])
db.truncate()
print(db.insert({'n': 'first after truncate'}))     # 4, expected 1

db.insert_multiple([{'n': 5}, {'n': 6}])
db.drop_tables()
print(db.insert({'n': 'first after drop_tables'}))  # 7, expected 1
```

Same thing with a named table (`db.table('events')`). If I close and reopen the file instead, IDs start at 1 as expected.
