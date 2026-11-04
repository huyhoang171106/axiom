# remove() with a query never returns

Removing documents by condition freezes my script at 100% CPU, no error:

```python
from tinydb import TinyDB, where

db = TinyDB('tasks.json')
db.insert_multiple([{'task': 'write', 'done': False}, {'task': 'read', 'done': True}])
db.remove(where('done') == True)   # hangs here
print(db.all())
```

It only returns when every document matches the condition (for example `db.remove(where('task').exists())`).
Removing by ID (`db.remove(doc_ids=[2])`) works. Ctrl+C shows the stack inside `remove`.
