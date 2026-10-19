# subtract() makes the number go up

I keep a small stock list in TinyDB and take items out with the `subtract` operation:

```python
from tinydb import TinyDB, where
from tinydb.operations import subtract

db = TinyDB('stock.json')
db.insert({'item': 'apple', 'stock': 10})
db.update(subtract('stock', 3), where('item') == 'apple')
print(db.get(where('item') == 'apple'))
```

Expected `{'item': 'apple', 'stock': 7}`, but I get `{'item': 'apple', 'stock': 13}`.
`increment` and `decrement` look fine. Python 3.12, TinyDB from the repo.
