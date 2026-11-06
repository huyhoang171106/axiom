import pytest
from tinydb import TinyDB, where
from tinydb.storages import MemoryStorage

def test_search_limit_on_table():
    db = TinyDB(storage=MemoryStorage)
    tbl = db.table('items')
    tbl.insert_multiple([{'x': i} for i in range(10)])

    res = tbl.search(where('x') >= 0, limit=3)
    assert len(res) == 3
    assert [doc['x'] for doc in res] == [0, 1, 2]

    assert tbl.search(where('x') >= 0, limit=0) == []
    assert tbl.search(where('x') >= 0, limit=-5) == []

    assert len(tbl.search(where('x') >= 8, limit=10)) == 2
    assert len(tbl.search(where('x') >= 0, limit=None)) == 10

def test_search_limit_on_tinydb():
    db = TinyDB(storage=MemoryStorage)
    db.insert_multiple([{'val': i} for i in range(5)])
    res = db.search(where('val') >= 0, limit=2)
    assert len(res) == 2
    assert [doc['val'] for doc in res] == [0, 1]
