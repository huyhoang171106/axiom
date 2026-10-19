from tinydb import Query, TinyDB
from tinydb.storages import MemoryStorage


def test_less_or_equal_includes_the_boundary():
    db = TinyDB(storage=MemoryStorage)
    db.insert_multiple([{'name': 'An', 'age': 25}, {'name': 'Binh', 'age': 30}, {'name': 'Chi', 'age': 35}])
    user = Query()
    assert sorted(u['name'] for u in db.search(user.age <= 30)) == ['An', 'Binh']


def test_less_or_equal_on_a_single_value():
    query = Query().score <= 10
    assert query({'score': 10})
    assert query({'score': 9.5})
    assert not query({'score': 10.01})
