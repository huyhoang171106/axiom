# insert() never returns after deleting a document and reopening the file

My script freezes, no error, 100% CPU. It happens on the first `insert` after I reopen a database where I had removed something:

```python
from tinydb import TinyDB, where

db = TinyDB('notes.json')
db.insert_multiple([{'id': 'a'}, {'id': 'b'}, {'id': 'c'}])
db.remove(where('id') == 'a')
db.close()

db = TinyDB('notes.json')
db.insert({'id': 'd'})   # hangs here forever
```

If I never delete anything, or keep using the same `TinyDB` object without reopening, it works. Ctrl+C shows the stack inside `insert`.
