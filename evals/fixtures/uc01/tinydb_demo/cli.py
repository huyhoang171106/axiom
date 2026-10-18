import argparse
from tinydb_demo.format import format_tags
from tinydb_demo.store import Store


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['list'])
    parser.add_argument('--format', default='tags')
    args = parser.parse_args()
    if args.command == 'list':
        for note in Store('notes.json').notes:
            print(format_tags(note))
