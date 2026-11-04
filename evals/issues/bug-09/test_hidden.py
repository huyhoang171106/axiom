from tinydb import TinyDB, where
from tinydb.storages import MemoryStorage


def test_remove_by_query_keeps_non_matching_documents():
    db = TinyDB(storage=MemoryStorage)
    db.insert_multiple([{'task': 'write', 'done': False}, {'task': 'read', 'done': True}])
    assert db.remove(where('done') == True) == [2]  # noqa: E712
    assert db.all() == [{'task': 'write', 'done': False}]


def test_remove_by_query_that_matches_nothing():
    db = TinyDB(storage=MemoryStorage)
    db.insert_multiple([{'n': 1}, {'n': 2}])
    assert db.remove(where('n') == 3) == []
    assert len(db) == 2
