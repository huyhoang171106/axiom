import json
from pathlib import Path


class Store:
    def __init__(self, filename):
        self.filename = Path(filename)
        self.notes = json.loads(self.filename.read_text()) if self.filename.exists() else []

    def add(self, note):
        self.notes.append(note)

    def search(self, query):
        return [note for note in self.notes if query in note['title']]

    def save(self):
        self.filename.write_text(json.dumps(self.notes))
