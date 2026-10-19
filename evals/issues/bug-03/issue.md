# LRUCache loses entries whose value is 0 or empty

I reuse `tinydb.utils.LRUCache` as a small cache in my app. Values like `0`, `''` or `[]` seem to vanish right after I store them:

```python
from tinydb.utils import LRUCache

cache = LRUCache(capacity=10)
cache['hits'] = 0
print('hits' in cache)   # True
print(cache['hits'])     # KeyError: 'hits'
```

`'hits' in cache` says the key is there, but reading it raises `KeyError`, and `cache.get('hits', -1)` returns `-1`.
Non-zero numbers and non-empty strings work. The existing test suite passes, so nothing seems to cover this.
