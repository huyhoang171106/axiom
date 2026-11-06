import pytest
from tinydb import TinyDB, where
from tinydb.storages import MemoryStorage
from tinydb.middlewares import ReadOnlyMiddleware

def test_readonly_middleware_reading():
    base = MemoryStorage()
    base.write({'_default': {1: {'a': 10}}})
    db = TinyDB(storage=ReadOnlyMiddleware(MemoryStorage))
    db._storage.storage = base
    assert len(db.all()) == 1
    assert db.all()[0]['a'] == 10

def test_readonly_middleware_blocks_writes():
    db = TinyDB(storage=ReadOnlyMiddleware(MemoryStorage))
    with pytest.raises(PermissionError):
        db.insert({'b': 20})
    with pytest.raises(PermissionError):
        db.truncate()
