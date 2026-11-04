from tinydb import Query, TinyDB
from tinydb.storages import MemoryStorage


def test_mutating_a_repeated_search_result_does_not_change_the_next_search():
    db = TinyDB(storage=MemoryStorage)
    db.insert_multiple([{'active': True, 'n': 1}, {'active': True, 'n': 2}, {'active': False, 'n': 3}])
    user = Query()
    first = db.search(user.active == True)  # noqa: E712
    second = db.search(user.active == True)  # noqa: E712
    first.clear()
    second.clear()
    assert sorted(d['n'] for d in db.search(user.active == True)) == [1, 2]  # noqa: E712


def test_repeated_search_returns_a_new_list_each_time():
    db = TinyDB(storage=MemoryStorage)
    db.insert({'x': 1})
    query = Query().x == 1
    assert db.search(query) is not db.search(query)
