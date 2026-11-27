import importlib.util, tempfile, unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('journal_store', Path(__file__).resolve().parents[1] / 'aws/journal/store.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MissedCloseJournalTest(unittest.TestCase):
    def test_current_journal_accepts_a_missed_close_without_a_result(self):
        with tempfile.TemporaryDirectory() as folder:
            store_class = next(v for v in vars(module).values() if isinstance(v, type) and hasattr(v, 'list_trades'))
            store = store_class(Path(folder) / 'journal.db')
            trade = {'id': 'shadow-1', 'entry': 246.5, 'exit': 245.0, 'quantity': 65, 'pnl': None, 'rAchieved': None,
                     'closeMissed': True, 'exitReasonCode': 'MISSED_CLOSE', 'closedAt': '2026-09-01T07:56:17Z'}
            self.assertTrue(store.event({'id': 'shadow-close:shadow-1', 'type': 'TRADE_CLOSED', 'trade': trade})['ok'])


if __name__ == '__main__':
    unittest.main()
