# `<=` query leaves out the boundary value

Searching with "less than or equal" skips documents that are exactly equal to the limit:

```python
from tinydb import TinyDB, Query

db = TinyDB('people.json')
db.insert_multiple([{'name': 'An', 'age': 25}, {'name': 'Binh', 'age': 30}, {'name': 'Chi', 'age': 35}])
User = Query()
print([u['name'] for u in db.search(User.age <= 30)])
```

Prints `['An']`. Binh is 30, so I expected `['An', 'Binh']`.
`>=` returns the boundary value as expected, so it is only `<=`.
