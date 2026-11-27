"""Some older tests hold two buys at once, for example one per strategy.

They lift the lot limit inside the test only. The app has no way to do this.
live_lot_limit_test.py checks the app with the real limit.
"""
from unittest import mock
from orders import Orders


def lift(case):
    patch=mock.patch.object(Orders,'_buy_in_use',staticmethod(lambda db:False))
    patch.start();case.addCleanup(patch.stop)
