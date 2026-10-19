import pytest

from tinydb.utils import LRUCache


@pytest.mark.parametrize('value', [0, '', [], False, 0.0])
def test_falsy_values_can_be_read_back(value):
    cache = LRUCache(capacity=10)
    cache['key'] = value
    assert cache['key'] == value
    assert cache.get('key', 'missing') == value


def test_reading_a_falsy_value_counts_as_recent_use():
    cache = LRUCache(capacity=2)
    cache['a'] = 0
    cache['b'] = 1
    _ = cache['a']  # 'a' is now the most recently used entry
    cache['c'] = 2  # so 'b' is evicted, not 'a'
    assert cache.lru == ['a', 'c']


def test_missing_key_still_returns_the_default():
    assert LRUCache(capacity=1).get('nope', 'missing') == 'missing'
