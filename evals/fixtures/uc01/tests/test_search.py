from tinydb_demo.store import Store


def test_search_is_case_insensitive(tmp_path):
    store = Store(tmp_path / 'db.json')
    store.add({'title': 'Hello World'})
    assert len(store.search('hello')) == 1
