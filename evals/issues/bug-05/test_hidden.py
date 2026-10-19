from tinydb import TinyDB, where


def test_insert_after_remove_and_reopen(tmp_path):
    path = tmp_path / 'notes.json'
    with TinyDB(path) as db:
        db.insert_multiple([{'id': 'a'}, {'id': 'b'}, {'id': 'c'}])
        db.remove(where('id') == 'a')

    with TinyDB(path) as db:
        new_id = db.insert({'id': 'd'})
        assert new_id == 4
        assert sorted(doc.doc_id for doc in db.all()) == [2, 3, 4]


def test_insert_after_removing_the_last_document(tmp_path):
    path = tmp_path / 'notes.json'
    with TinyDB(path) as db:
        db.insert_multiple([{'id': 'a'}, {'id': 'b'}])
        db.remove(where('id') == 'b')

    with TinyDB(path) as db:
        assert db.insert({'id': 'c'}) == 2
