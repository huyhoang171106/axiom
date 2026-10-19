from tinydb import TinyDB
from tinydb.storages import MemoryStorage


def test_ids_restart_after_truncate():
    db = TinyDB(storage=MemoryStorage)
    db.insert_multiple([{'n': 1}, {'n': 2}, {'n': 3}])
    db.truncate()
    assert db.insert({'n': 'first'}) == 1
    assert len(db) == 1


def test_ids_restart_after_drop_tables():
    db = TinyDB(storage=MemoryStorage)
    events = db.table('events')
    events.insert_multiple([{'n': 1}, {'n': 2}])
    db.drop_tables()
    assert db.table('events').insert({'n': 'first'}) == 1
    assert db.insert({'n': 'default table'}) == 1


def test_drop_tables_gives_fresh_table_objects():
    db = TinyDB(storage=MemoryStorage)
    before = db.table('events')
    db.drop_tables()
    assert db.table('events') is not before
