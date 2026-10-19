from tinydb import TinyDB, where
from tinydb.operations import subtract
from tinydb.storages import MemoryStorage


def test_subtract_lowers_the_value():
    db = TinyDB(storage=MemoryStorage)
    db.insert({'item': 'apple', 'stock': 10})
    db.update(subtract('stock', 3), where('item') == 'apple')
    assert db.get(where('item') == 'apple')['stock'] == 7


def test_subtract_with_float_and_negative_amounts():
    db = TinyDB(storage=MemoryStorage)
    db.insert({'item': 'pear', 'stock': 2.5})
    db.update(subtract('stock', 0.5), where('item') == 'pear')
    assert db.get(where('item') == 'pear')['stock'] == 2.0
    db.update(subtract('stock', -1), where('item') == 'pear')
    assert db.get(where('item') == 'pear')['stock'] == 3.0
