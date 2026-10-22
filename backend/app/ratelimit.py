"""In-process sliding-window rate limiter (per worker process; fine for a single-instance MVP)."""

from __future__ import annotations

import threading
import time
from collections import deque


class RateLimiter:
    def __init__(self, max_events: int, window_s: float) -> None:
        self.max_events = max_events
        self.window_s = window_s
        self._events: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, key: str, now: float) -> deque[float]:
        queue = self._events.setdefault(key, deque())
        while queue and now - queue[0] > self.window_s:
            queue.popleft()
        return queue

    def allowed(self, key: str) -> bool:
        with self._lock:
            return len(self._recent(key, time.monotonic())) < self.max_events

    def hit(self, key: str) -> bool:
        """Record an event; returns False (and records nothing) when the key is already at its limit."""
        with self._lock:
            now = time.monotonic()
            queue = self._recent(key, now)
            if len(queue) >= self.max_events:
                return False
            queue.append(now)
            if len(self._events) > 10_000:
                self._events = {k: q for k, q in self._events.items() if q}
            return True

    def reset(self, key: str) -> None:
        with self._lock:
            self._events.pop(key, None)
