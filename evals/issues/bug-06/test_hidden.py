from tinydb import Query, TinyDB
from tinydb.storages import MemoryStorage


def test_greater_or_equal_includes_the_boundary():
    db = TinyDB(storage=MemoryStorage)
    db.insert_multiple([{'id': 1, 'total': 99}, {'id': 2, 'total': 100}, {'id': 3, 'total': 150}])
    order = Query()
    assert sorted(o['id'] for o in db.search(order.total >= 100)) == [2, 3]


def test_greater_or_equal_on_a_single_value():
    query = Query().score >= 10
    assert query({'score': 10})
    assert query({'score': 10.5})
    assert not query({'score': 9.99})
