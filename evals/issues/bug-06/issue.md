# "At least" query drops the record that is exactly at the minimum

I filter orders by a minimum amount:

```python
from tinydb import TinyDB, Query

db = TinyDB('orders.json')
db.insert_multiple([{'id': 1, 'total': 99}, {'id': 2, 'total': 100}, {'id': 3, 'total': 150}])
Order = Query()
print([o['id'] for o in db.search(Order.total >= 100)])
```

Prints `[3]`. Order 2 has a total of exactly 100, so I expected `[2, 3]`.
`Order.total > 99` gives `[2, 3]` as expected.
