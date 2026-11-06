import pytest
from tinydb import TinyDB, where
from tinydb.storages import MemoryStorage

def test_table_count_where():
    db = TinyDB(storage=MemoryStorage)
    tbl = db.table('items')
    tbl.insert_multiple([
        {'val': 1, 'tag': 'a'},
        {'val': 2, 'tag': 'b'},
        {'val': 3, 'tag': 'a'},
        {'val': 4, 'tag': 'c'},
    ])
    assert tbl.count_where(where('tag') == 'a') == 2
    assert tbl.count_where(where('val') > 2) == 2
    assert tbl.count_where(where('tag') == 'nonexistent') == 0

def test_tinydb_count_where():
    db = TinyDB(storage=MemoryStorage)
    db.insert_multiple([
        {'val': 10},
        {'val': 20},
        {'val': 30},
    ])
    assert db.count_where(where('val') >= 20) == 2
    assert db.count_where(where('val') < 0) == 0
