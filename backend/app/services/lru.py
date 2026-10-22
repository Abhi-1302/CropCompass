"""Small thread-safe LRU caches for engine results (per process)."""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable


class LruCache[T]:
    def __init__(self, size: int) -> None:
        self.size = size
        self._items: OrderedDict[tuple, T] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: tuple) -> T | None:
        with self._lock:
            value = self._items.get(key)
            if value is not None:
                self._items.move_to_end(key)
            return value

    def put(self, key: tuple, value: T) -> T:
        with self._lock:
            self._items[key] = value
            self._items.move_to_end(key)
            while len(self._items) > self.size:
                self._items.popitem(last=False)
        return value

    def get_or_compute(self, key: tuple, compute: Callable[[], T], before: Callable[[], None] | None = None) -> T:
        """Cached value, or `before()` (e.g. a rate-limit check) then `compute()`."""
        cached = self.get(key)
        if cached is not None:
            return cached
        if before is not None:
            before()
        return self.put(key, compute())
