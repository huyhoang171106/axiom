from tinydb import Query, TinyDB
from tinydb.storages import MemoryStorage


def test_search_sees_an_update_of_the_same_query():
    db = TinyDB(storage=MemoryStorage)
    item = Query()
    db.insert({'name': 'pen', 'price': 2})
    assert db.search(item.name == 'pen')[0]['price'] == 2
    db.update({'price': 3}, item.name == 'pen')
    assert db.search(item.name == 'pen')[0]['price'] == 3
    db.insert({'name': 'pen', 'price': 4})
    assert sorted(d['price'] for d in db.search(item.name == 'pen')) == [3, 4]


def test_a_dropped_table_starts_empty_when_opened_again():
    db = TinyDB(storage=MemoryStorage)
    query = Query().kind == 'start'
    events = db.table('events')
    events.insert({'kind': 'start'})
    assert len(events.search(query)) == 1
    db.drop_table('events')
    reopened = db.table('events')
    assert reopened is not events
    assert reopened.search(query) == []
